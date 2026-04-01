const crypto = require('crypto');

function buildPeriodData(payload) {
    const qs = new URLSearchParams();
    Object.entries(payload).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
            qs.append(key, String(value));
        }
    });
    return qs.toString();
}

function encryptPeriod(periodData, hashKey, hashIV) {
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(hashKey), Buffer.from(hashIV));
    cipher.setAutoPadding(true);
    let encrypted = cipher.update(periodData, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
}

async function postJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, json };
}

async function main() {
    const baseUrl = process.env.SMOKE_BASE_URL || 'https://booking-system-mt-production.up.railway.app';
    const hashKey = (process.env.NEWEBPAY_HASH_KEY || '').trim();
    const hashIV = (process.env.NEWEBPAY_HASH_IV || '').trim();
    const tenantId = parseInt(process.env.SMOKE_TENANT_ID || process.env.DEFAULT_TENANT_ID || '1', 10) || 1;

    if (!hashKey || !hashIV) {
        throw new Error('缺少 NEWEBPAY_HASH_KEY / NEWEBPAY_HASH_IV 環境變數，無法進行 webhook smoke test');
    }

    const eventId = `smoke-${Date.now()}`;
    const payloadCore = {
        Status: 'SUCCESS',
        Message: '授權成功',
        Result: JSON.stringify({
            MerchantOrderNo: `T${tenantId}-${Date.now()}`,
            PeriodNo: eventId,
            TradeNo: `SMOKE${Date.now()}`,
            RespondCode: '00'
        })
    };
    const periodData = buildPeriodData(payloadCore);
    const encryptedPeriod = encryptPeriod(periodData, hashKey, hashIV);
    const webhookPayload = {
        Period: encryptedPeriod,
        EventType: 'subscription.renewal'
    };

    const endpoint = `${baseUrl.replace(/\/$/, '')}/api/payment/newebpay/subscription/webhook`;
    console.log(`🔎 POST ${endpoint}`);

    const first = await postJson(endpoint, webhookPayload);
    console.log('第一次送出:', first.status, JSON.stringify(first.json));
    if (!first.ok || !first.json.success) {
        throw new Error(`第一次 webhook 失敗: HTTP ${first.status} ${first.json.message || ''}`.trim());
    }

    const second = await postJson(endpoint, webhookPayload);
    console.log('第二次送出(重送):', second.status, JSON.stringify(second.json));
    if (!second.ok || !second.json.success) {
        throw new Error(`第二次 webhook 失敗: HTTP ${second.status} ${second.json.message || ''}`.trim());
    }
    if (!second.json.duplicate) {
        throw new Error('預期第二次應為 duplicate=true，但實際不是，去重機制可能異常');
    }

    console.log('✅ NewebPay webhook smoke test passed');
}

main().catch((error) => {
    console.error('❌ NewebPay webhook smoke test failed:', error.message);
    process.exit(1);
});
