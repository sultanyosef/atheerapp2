require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// السماح بطلبات الواجهة الأمامية (يُفضّل تحديد نطاق موقعك في الإنتاج)
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MOYASAR_SECRET_KEY = process.env.MOYASAR_SECRET_KEY || 'sk_test_YOUR_SECRET_KEY_HERE';
const APP_RETURN_URL = process.env.APP_RETURN_URL || 'http://localhost:5500/index.html';

// الباقات المعتمدة (المبالغ بالهللة: 500 = 5.00 SAR)
const PACKAGES = {
    100: { coins: 100, amountHalalas: 500, currency: 'SAR' },
    300: { coins: 300, amountHalalas: 1500, currency: 'SAR' },
    700: { coins: 700, amountHalalas: 3000, currency: 'SAR' }
};

// سجل مؤقت في الذاكرة لتتبع الفواتير ومنع احتساب الفاتورة المدفوعة أكثر من مرة
const processedInvoices = new Map();

function getAuthHeader() {
    const encoded = Buffer.from(`${MOYASAR_SECRET_KEY}:`).toString('base64');
    return `Basic ${encoded}`;
}

// فحص حالة الخادم
app.get('/', (req, res) => {
    res.json({
        ok: true,
        service: 'atheer-payment-server',
        endpoints: [
            'POST /api/topup/visa/create',
            'GET  /api/topup/visa/verify?id=INVOICE_ID'
        ]
    });
});

// 1) إنشاء فاتورة دفع فيزا وإرجاع رابط صفحة الدفع الآمنة
app.post('/api/topup/visa/create', async (req, res) => {
    try {
        const { coins, uid } = req.body || {};
        const pkg = PACKAGES[Number(coins)];

        if (!pkg) {
            return res.status(400).json({ error: 'باقة العملات غير صالحة' });
        }

        if (!MOYASAR_SECRET_KEY || MOYASAR_SECRET_KEY.includes('YOUR_SECRET_KEY_HERE')) {
            return res.status(500).json({
                error: 'يرجى ضبط MOYASAR_SECRET_KEY في متغيرات البيئة أولاً'
            });
        }

        const safeUid = String(uid || 'guest').trim() || 'guest';
        const separator = APP_RETURN_URL.includes('?') ? '&' : '?';
        const callbackUrl = `${APP_RETURN_URL}${separator}uid=${encodeURIComponent(safeUid)}&coins=${pkg.coins}`;

        const response = await fetch('https://api.moyasar.com/v1/invoices', {
            method: 'POST',
            headers: {
                'Authorization': getAuthHeader(),
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                amount: pkg.amountHalalas,
                currency: pkg.currency,
                description: `شحن ${pkg.coins} عملة`,
                callback_url: callbackUrl,
                metadata: {
                    uid: safeUid,
                    coins: pkg.coins
                }
            })
        });

        const data = await response.json();

        if (!response.ok || !data.url) {
            return res.status(response.status || 400).json({
                error: data.message || 'تعذر إنشاء فاتورة الدفع'
            });
        }

        return res.json({
            invoiceId: data.id,
            checkoutUrl: data.url,
            coins: pkg.coins
        });
    } catch (error) {
        return res.status(500).json({
            error: 'حدث خطأ في الخادم أثناء إنشاء الفاتورة'
        });
    }
});

// 2) التحقق من حالة الفاتورة بعد العودة من صفحة الدفع
app.get('/api/topup/visa/verify', async (req, res) => {
    try {
        const invoiceId = String(req.query.id || '').trim();
        const requestedCoins = Number(req.query.coins || 0);

        if (!invoiceId) {
            return res.status(400).json({
                paid: false,
                error: 'معرف الفاتورة (id) مطلوب'
            });
        }

        if (!MOYASAR_SECRET_KEY || MOYASAR_SECRET_KEY.includes('YOUR_SECRET_KEY_HERE')) {
            return res.status(500).json({
                paid: false,
                error: 'مفتاح الدفع غير مضبوط على الخادم'
            });
        }

        const response = await fetch(
            `https://api.moyasar.com/v1/invoices/${encodeURIComponent(invoiceId)}`,
            {
                method: 'GET',
                headers: {
                    'Authorization': getAuthHeader(),
                    'Accept': 'application/json'
                }
            }
        );

        const invoice = await response.json();

        if (!response.ok) {
            return res.status(response.status || 400).json({
                paid: false,
                error: invoice.message || 'تعذر جلب بيانات الفاتورة'
            });
        }

        const isPaid = invoice.status === 'paid';
        const metadataCoins = Number(invoice.metadata && invoice.metadata.coins ? invoice.metadata.coins : 0);
        const coinsToGrant = metadataCoins || requestedCoins || 0;

        if (!isPaid) {
            return res.json({
                paid: false,
                status: invoice.status || 'unpaid',
                coins: 0
            });
        }

        // منع منح العملات لنفس الفاتورة أكثر من مرة
        if (processedInvoices.has(invoice.id)) {
            return res.json({
                paid: true,
                alreadyCredited: true,
                status: invoice.status,
                invoiceId: invoice.id,
                coins: 0
            });
        }

        processedInvoices.set(invoice.id, {
            uid: invoice.metadata?.uid || 'guest',
            coins: coinsToGrant,
            paidAt: new Date().toISOString()
        });

        return res.json({
            paid: true,
            alreadyCredited: false,
            status: invoice.status,
            invoiceId: invoice.id,
            coins: coinsToGrant
        });
    } catch (error) {
        return res.status(500).json({
            paid: false,
            error: 'حدث خطأ أثناء التحقق من الفاتورة'
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});