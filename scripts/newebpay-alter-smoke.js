async function postJson(url, body, cookieHeader = '') {
    const headers = {
        'Content-Type': 'application/json'
    };
    if (cookieHeader) {
        headers.Cookie = cookieHeader;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });
    const json = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, json };
}

function buildBaseUrl() {
    return (process.env.SMOKE_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function getRequiredEnv(name) {
    const value = String(process.env[name] || '').trim();
    if (!value) {
        throw new Error(`缺少必要環境變數：${name}`);
    }
    return value;
}

async function runAlterStatus(baseUrl, cookieHeader) {
    const endpoint = `${baseUrl}/api/payment/newebpay/subscription/alter-status`;
    const body = {
        merOrderNo: getRequiredEnv('SMOKE_MER_ORDER_NO'),
        periodNo: getRequiredEnv('SMOKE_PERIOD_NO'),
        alterType: process.env.SMOKE_ALTER_TYPE || 'suspend'
    };

    console.log(`🔎 POST ${endpoint}`);
    console.log('📦 Body:', JSON.stringify(body));
    const result = await postJson(endpoint, body, cookieHeader);
    console.log('📨 Response:', result.status, JSON.stringify(result.json));
    if (!result.ok || !result.json.success) {
        throw new Error(`alter-status 失敗: HTTP ${result.status} ${result.json.message || ''}`.trim());
    }
}

async function runAlterContent(baseUrl, cookieHeader) {
    const endpoint = `${baseUrl}/api/payment/newebpay/subscription/alter-content`;
    const body = {
        merOrderNo: getRequiredEnv('SMOKE_MER_ORDER_NO'),
        periodNo: getRequiredEnv('SMOKE_PERIOD_NO')
    };

    if (process.env.SMOKE_ALTER_AMT) body.alterAmt = process.env.SMOKE_ALTER_AMT;
    if (process.env.SMOKE_PERIOD_TYPE) body.periodType = process.env.SMOKE_PERIOD_TYPE;
    if (process.env.SMOKE_PERIOD_POINT) body.periodPoint = process.env.SMOKE_PERIOD_POINT;
    if (process.env.SMOKE_PERIOD_TIMES) body.periodTimes = process.env.SMOKE_PERIOD_TIMES;
    if (process.env.SMOKE_EXTDAY) body.extday = process.env.SMOKE_EXTDAY;
    if (process.env.SMOKE_NOTIFY_URL) body.notifyUrl = process.env.SMOKE_NOTIFY_URL;

    if (
        body.alterAmt === undefined &&
        body.periodType === undefined &&
        body.periodPoint === undefined &&
        body.periodTimes === undefined &&
        body.extday === undefined &&
        body.notifyUrl === undefined
    ) {
        body.alterAmt = process.env.SMOKE_DEFAULT_ALTER_AMT || '99';
    }

    console.log(`🔎 POST ${endpoint}`);
    console.log('📦 Body:', JSON.stringify(body));
    const result = await postJson(endpoint, body, cookieHeader);
    console.log('📨 Response:', result.status, JSON.stringify(result.json));
    if (!result.ok || !result.json.success) {
        throw new Error(`alter-content 失敗: HTTP ${result.status} ${result.json.message || ''}`.trim());
    }
}

async function main() {
    const baseUrl = buildBaseUrl();
    const cookieHeader = String(process.env.SMOKE_ADMIN_COOKIE || '').trim();
    const mode = String(process.env.SMOKE_MODE || 'both').trim().toLowerCase();
    const allowed = new Set(['both', 'status', 'content']);
    if (!allowed.has(mode)) {
        throw new Error('SMOKE_MODE 僅允許 both | status | content');
    }

    console.log(`🚀 NewebPay alter smoke start (mode=${mode})`);
    if (!cookieHeader) {
        console.log('⚠️  未帶 SMOKE_ADMIN_COOKIE，若端點需登入會回 401');
    }

    if (mode === 'both' || mode === 'status') {
        await runAlterStatus(baseUrl, cookieHeader);
    }
    if (mode === 'both' || mode === 'content') {
        await runAlterContent(baseUrl, cookieHeader);
    }

    console.log('✅ NewebPay alter smoke test passed');
}

main().catch((error) => {
    console.error('❌ NewebPay alter smoke test failed:', error.message);
    process.exit(1);
});
