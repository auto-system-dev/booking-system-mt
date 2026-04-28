function createPaymentService(deps) {
    const crypto = require('crypto');
    const {
        db,
        notificationService,
        logPaymentEvent,
        processEnv
    } = deps;
    const defaultTenantId = parseInt(processEnv.DEFAULT_TENANT_ID || '1', 10);

    async function getEcpayConfigFromSettings(requiredKeys = ['MerchantID', 'HashKey', 'HashIV']) {
        const isProductionEnv = processEnv.NODE_ENV === 'production';
        const envKeyMap = isProductionEnv
            ? {
                MerchantID: 'ECPAY_MERCHANT_ID_PROD',
                HashKey: 'ECPAY_HASH_KEY_PROD',
                HashIV: 'ECPAY_HASH_IV_PROD'
            }
            : {
                MerchantID: 'ECPAY_MERCHANT_ID',
                HashKey: 'ECPAY_HASH_KEY',
                HashIV: 'ECPAY_HASH_IV'
            };

        const dbConfig = {
            MerchantID: ((await db.getSetting('ecpay_merchant_id', defaultTenantId)) || '').trim(),
            HashKey: ((await db.getSetting('ecpay_hash_key', defaultTenantId)) || '').trim(),
            HashIV: ((await db.getSetting('ecpay_hash_iv', defaultTenantId)) || '').trim()
        };

        const config = {
            isProduction: isProductionEnv,
            MerchantID: dbConfig.MerchantID || (processEnv[envKeyMap.MerchantID] || '').trim(),
            HashKey: dbConfig.HashKey || (processEnv[envKeyMap.HashKey] || '').trim(),
            HashIV: dbConfig.HashIV || (processEnv[envKeyMap.HashIV] || '').trim()
        };

        const missing = requiredKeys.filter((key) => !config[key]);
        if (missing.length > 0) {
            const envNames = missing.map((key) => envKeyMap[key]).join('、');
            throw new Error(
                `綠界支付設定不完整，缺少：${missing.join(', ')}。請在系統設定的「綠界支付設定」中設定，或使用環境變數 ${envNames}`
            );
        }

        return config;
    }

    function maskSecretForLog(value, keepTail = 4) {
        const raw = String(value || '').trim();
        if (!raw) return '(empty)';
        if (raw.length <= keepTail) return '*'.repeat(raw.length);
        return `${'*'.repeat(Math.max(1, raw.length - keepTail))}${raw.slice(-keepTail)}`;
    }

    async function getNewebpayConfigFromSettings(requiredKeys = ['MerchantID', 'HashKey', 'HashIV'], tenantId = defaultTenantId) {
        const safeTenantId = parseInt(tenantId, 10) || defaultTenantId;
        const settingValue = String((await db.getSetting('newebpay_is_production', safeTenantId)) || '').trim().toLowerCase();
        const envValue = String(processEnv.NEWEBPAY_IS_PRODUCTION || '').trim().toLowerCase();
        // 優先順序：資料庫設定 > 環境變數 > NODE_ENV 自動推斷（production=true）
        const isProduction = settingValue
            ? settingValue === 'true'
            : (envValue ? envValue === 'true' : processEnv.NODE_ENV === 'production');
        const dbMerchantID = ((await db.getSetting('newebpay_merchant_id', safeTenantId)) || '').trim();
        const dbHashKey = ((await db.getSetting('newebpay_hash_key', safeTenantId)) || '').trim();
        const dbHashIV = ((await db.getSetting('newebpay_hash_iv', safeTenantId)) || '').trim();
        const envMerchantID = String(processEnv.NEWEBPAY_MERCHANT_ID || '').trim();
        const envHashKey = String(processEnv.NEWEBPAY_HASH_KEY || '').trim();
        const envHashIV = String(processEnv.NEWEBPAY_HASH_IV || '').trim();
        const config = {
            MerchantID: dbMerchantID || envMerchantID,
            HashKey: dbHashKey || envHashKey,
            HashIV: dbHashIV || envHashIV,
            isProduction,
            debugMeta: {
                tenantId: safeTenantId,
                isProduction,
                modeSource: settingValue ? 'db' : (envValue ? 'env' : 'node_env'),
                merchantSource: dbMerchantID ? 'db' : (envMerchantID ? 'env' : 'missing'),
                hashKeySource: dbHashKey ? 'db' : (envHashKey ? 'env' : 'missing'),
                hashIVSource: dbHashIV ? 'db' : (envHashIV ? 'env' : 'missing'),
                merchantMasked: maskSecretForLog(dbMerchantID || envMerchantID)
            }
        };
        const missing = requiredKeys.filter((key) => !config[key]);
        if (missing.length > 0) {
            throw new Error(`藍新支付設定不完整，缺少：${missing.join(', ')}`);
        }
        return config;
    }

    function encryptNewebpayTradeInfo(params, config) {
        const qs = new URLSearchParams();
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                qs.append(key, String(value));
            }
        });
        const raw = qs.toString();
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(config.HashKey), Buffer.from(config.HashIV));
        cipher.setAutoPadding(true);
        let encrypted = cipher.update(raw, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
    }

    function decryptNewebpayPayload(encryptedHex, config, fieldName = 'Period') {
        const rawCipher = String(encryptedHex || '').trim();
        let cipherHex = rawCipher;
        if (cipherHex.includes('%')) {
            try {
                cipherHex = decodeURIComponent(cipherHex);
            } catch (_) {
                // keep original when decoding fails
            }
        }
        cipherHex = cipherHex.replace(/\s+/g, '').replace(/^0x/i, '');
        if (/[^0-9a-f]/i.test(cipherHex) && /[0-9a-f]/i.test(cipherHex)) {
            const onlyHex = cipherHex.replace(/[^0-9a-f]/ig, '');
            if (onlyHex.length >= 32) {
                cipherHex = onlyHex;
            }
        }
        if (!cipherHex) {
            throw new Error(`缺少藍新回傳 ${fieldName} 參數`);
        }
        try {
            const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(config.HashKey), Buffer.from(config.HashIV));
            decipher.setAutoPadding(true);
            let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (firstError) {
            // NDNP 手冊範例採 OPENSSL_ZERO_PADDING + 手動去除 PKCS7。
            // 這裡做第二條相容路徑，避免某些回傳格式在 auto padding 下失敗。
            try {
                const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(config.HashKey), Buffer.from(config.HashIV));
                decipher.setAutoPadding(false);
                const raw = Buffer.concat([
                    decipher.update(Buffer.from(cipherHex, 'hex')),
                    decipher.final()
                ]);
                const padLen = raw[raw.length - 1];
                if (padLen > 0 && padLen <= 16) {
                    const start = raw.length - padLen;
                    let validPad = true;
                    for (let i = start; i < raw.length; i += 1) {
                        if (raw[i] !== padLen) {
                            validPad = false;
                            break;
                        }
                    }
                    if (validPad) {
                        return raw.slice(0, start).toString('utf8');
                    }
                }
                return raw.toString('utf8').replace(/\x00+$/g, '');
            } catch (_) {
                throw firstError;
            }
        }
    }

    function decryptNewebpayPeriod(encryptedHex, config) {
        return decryptNewebpayPayload(encryptedHex, config, 'Period');
    }

    /** 藍新 AES 密文為純 hex；JSON 明文（以 { 開頭）應直接解析，不可當 hex 解密。 */
    function isLikelyNewebpayPeriodCipherHex(str) {
        const raw = String(str || '').trim();
        if (!raw || raw.startsWith('{') || raw.startsWith('[')) return false;
        let cipherHex = raw;
        if (cipherHex.includes('%')) {
            try {
                cipherHex = decodeURIComponent(cipherHex);
            } catch (_) {
                /* keep */
            }
        }
        cipherHex = cipherHex.replace(/\s+/g, '').replace(/^0x/i, '');
        if (/[^0-9a-f]/i.test(cipherHex) && /[0-9a-f]/i.test(cipherHex)) {
            const onlyHex = cipherHex.replace(/[^0-9a-f]/gi, '');
            if (onlyHex.length >= 32) cipherHex = onlyHex;
        }
        return cipherHex.length >= 32 && /^[0-9a-f]+$/i.test(cipherHex);
    }

    function tryParseNewebpayPayloadWithoutDecrypt(rawValue) {
        const rawText = String(rawValue || '').trim();
        if (!rawText) return null;
        const candidates = [rawText];
        if (rawText.includes('%')) {
            try {
                candidates.push(decodeURIComponent(rawText));
            } catch (_) {
                // ignore decode failure
            }
        }
        try {
            const b64 = Buffer.from(rawText, 'base64').toString('utf8').trim();
            if (b64) candidates.push(b64);
        } catch (_) {
            // ignore base64 decode failure
        }
        for (const text of candidates) {
            try {
                return parseNewebpayPeriodPayload(text);
            } catch (_) {
                // try next candidate
            }
        }
        return null;
    }

    function parseNewebpayPeriodPayload(raw) {
        const sanitizeJsonText = (value) => {
            let text = String(value || '');
            // 去掉常見 BOM / 零寬字元，避免 JSON 開頭判斷失敗
            text = text.replace(/^[\uFEFF\u200B\u200C\u200D]+/, '').trim();
            return text;
        };
        const text = sanitizeJsonText(raw);
        if (!text) {
            throw new Error('藍新回傳內容為空');
        }

        const tryParseEmbeddedJsonObject = (value) => {
            const source = sanitizeJsonText(value);
            if (!source) return null;
            try {
                const parsed = JSON.parse(source);
                if (parsed && typeof parsed === 'object') return parsed;
                if (typeof parsed === 'string') {
                    const nested = JSON.parse(sanitizeJsonText(parsed));
                    if (nested && typeof nested === 'object') return nested;
                }
            } catch (_) {
                // 兼容被跳脫過一次的 JSON 文字：{\"Status\":\"SUCCESS\"...}
                try {
                    const unescaped = source.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                    const recovered = JSON.parse(unescaped);
                    if (recovered && typeof recovered === 'object') return recovered;
                } catch (__err) {
                    // ignore
                }
            }
            return null;
        };

        const normalizeSingleJsonKeyObject = (obj) => {
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
            const keys = Object.keys(obj);
            if (keys.length !== 1) return obj;
            const onlyKey = sanitizeJsonText(keys[0]);
            // 有些回傳會被 parse 成 { '{"Status":"SUCCESS",...}': '...' }，
            // 即使 value 不是空字串，關鍵資料仍在 key 裡，這裡優先嘗試還原。
            const recovered = tryParseEmbeddedJsonObject(onlyKey);
            return recovered || obj;
        };

        const embeddedParsed = tryParseEmbeddedJsonObject(text);
        if (embeddedParsed) {
            return normalizeSingleJsonKeyObject(embeddedParsed);
        }

        try {
            const obj = JSON.parse(text);
            if (obj && typeof obj.Result === 'string') {
                try {
                    obj.Result = JSON.parse(obj.Result);
                } catch (_) {
                    // keep original string when not JSON
                }
            }
            return normalizeSingleJsonKeyObject(obj);
        } catch (_) {
            const parsed = Object.fromEntries(new URLSearchParams(text).entries());
            if (parsed && typeof parsed.Result === 'string') {
                try {
                    parsed.Result = JSON.parse(parsed.Result);
                } catch (_) {
                    // keep original string when not JSON
                }
            }
            if (!parsed || Object.keys(parsed).length === 0) {
                throw new Error('藍新回傳 Period 解密內容格式無法解析');
            }
            return normalizeSingleJsonKeyObject(parsed);
        }
    }

    function buildNewebpayTradeSha(tradeInfo, config) {
        return crypto
            .createHash('sha256')
            .update(`HashKey=${config.HashKey}&${tradeInfo}&HashIV=${config.HashIV}`)
            .digest('hex')
            .toUpperCase();
    }

    async function postNewebpayPeriodApi(actionUrl, payload) {
        const body = new URLSearchParams();
        Object.entries(payload || {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                body.append(key, String(value));
            }
        });
        const response = await fetch(actionUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`藍新 API 呼叫失敗，HTTP ${response.status}`);
        }

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (_) {
            parsed = Object.fromEntries(new URLSearchParams(text).entries());
        }

        return parsed;
    }

    async function createNewebpaySubscriptionRequest(params = {}) {
        const {
            tenantId,
            planCode,
            returnUrl,
            notifyUrl,
            customerEmail,
            customerName
        } = params;

        const safeTenantId = parseInt(tenantId, 10) || defaultTenantId;
        const config = await getNewebpayConfigFromSettings(['MerchantID', 'HashKey', 'HashIV'], safeTenantId);
        const plans = await db.getSubscriptionPlans();
        const selectedPlan = plans.find((p) => p.code === planCode) || plans.find((p) => p.code === 'pro_monthly') || plans[0];
        if (!selectedPlan) {
            throw new Error('找不到可用方案，請先建立訂閱方案');
        }

        const amount = Math.max(1, parseInt(selectedPlan.price_amount || 0, 10) || 1);
        const billingCycle = selectedPlan.billing_cycle === 'yearly' ? 'yearly' : 'monthly';
        const recurringMode = String(selectedPlan?.feature_flags?.recurring_mode || 'calendar').trim().toLowerCase();
        const recurringValueRaw = parseInt(selectedPlan?.feature_flags?.recurring_value || 0, 10);
        let periodType = billingCycle === 'yearly' ? 'Y' : 'M';
        // 藍新要求固定長度：月繳 DD（01-31），年繳 MMDD（0101-1231），固定天期 D（2-999）
        let periodPoint = '01';
        if (periodType === 'Y') {
            // 年繳以「該用戶建立授權當天」作為每年扣款錨點（MMDD）
            const now = new Date();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            periodPoint = `${mm}${dd}`;
        }
        if (recurringMode === 'fixed_days' && billingCycle !== 'yearly') {
            periodType = 'D';
            const safeDays = Math.max(2, Math.min(364, recurringValueRaw || 30));
            periodPoint = String(safeDays);
        } else if (periodType === 'M') {
            const safeDay = Math.max(1, Math.min(31, recurringValueRaw || 1));
            periodPoint = String(safeDay).padStart(2, '0');
        }
        const periodAmt = String(amount);
        // 藍新授權期數上限為 99，月繳/年繳都以 99 作為長期續扣預設；
        // 若需提前停止，改由使用者取消訂閱（terminate）。
        const periodTimes = '99';
        const ts = Math.floor(Date.now() / 1000);
        // 藍新 MerOrderNo 僅允許英數與底線，避免使用連字號造成 PER10010
        const merchantOrderNo = `T${safeTenantId}_${Date.now()}`.replace(/[^A-Za-z0-9_]/g, '').slice(0, 30);
        const planName = String(selectedPlan.name || selectedPlan.code || '訂閱方案').trim();
        const cycleLabel = billingCycle === 'yearly' ? '年繳' : '月繳';
        const itemDesc = `${planName}（${cycleLabel}）`;
        const version = '1.5';
        const actionUrl = config.isProduction
            ? 'https://core.newebpay.com/MPG/period'
            : 'https://ccore.newebpay.com/MPG/period';
        logPaymentEvent('info', 'payment.newebpay.subscription.create.config', {
            tenantId: safeTenantId,
            planCode: selectedPlan.code,
            actionUrl,
            isProduction: !!config.isProduction,
            merchantMasked: config?.debugMeta?.merchantMasked || '(unknown)',
            modeSource: config?.debugMeta?.modeSource || '(unknown)',
            merchantSource: config?.debugMeta?.merchantSource || '(unknown)',
            hashKeySource: config?.debugMeta?.hashKeySource || '(unknown)',
            hashIVSource: config?.debugMeta?.hashIVSource || '(unknown)',
            hasNotifyUrl: !!(notifyUrl || processEnv.NEWEBPAY_SUBSCRIPTION_NOTIFY_URL || ''),
            hasBackUrl: !!(returnUrl || processEnv.NEWEBPAY_SUBSCRIPTION_RETURN_URL || '')
        });

        const notifyUrlResolved = buildNewebpayWebhookNotifyUrl(
            notifyUrl || processEnv.NEWEBPAY_SUBSCRIPTION_NOTIFY_URL || '',
            returnUrl || processEnv.NEWEBPAY_SUBSCRIPTION_RETURN_URL || '',
            safeTenantId
        );
        const backUrlResolved = buildNewebpayBrowserReturnUrl(
            returnUrl || processEnv.NEWEBPAY_SUBSCRIPTION_RETURN_URL || '',
            safeTenantId
        );
        const tradeParams = {
            MerchantID: config.MerchantID,
            RespondType: 'JSON',
            TimeStamp: String(ts),
            Version: version,
            MerOrderNo: merchantOrderNo,
            ProdDesc: itemDesc,
            PeriodAmt: periodAmt,
            PeriodType: periodType,
            PeriodPoint: periodPoint,
            PeriodStartType: '2',
            PeriodTimes: periodTimes,
            // Period 回跳欄位在不同版本文件語義略有差異，統一導向中轉頁避免回跳混亂
            ReturnURL: backUrlResolved || notifyUrlResolved,
            NotifyURL: notifyUrlResolved,
            BackURL: backUrlResolved,
            PayerEmail: customerEmail || '',
            PayerName: customerName || ''
        };
        if (!tradeParams.ReturnURL && !tradeParams.NotifyURL) {
            throw new Error('缺少藍新 webhook 通知網址，請設定 NEWEBPAY_SUBSCRIPTION_NOTIFY_URL');
        }

        const tradeInfo = encryptNewebpayTradeInfo(tradeParams, config);
        return {
            actionUrl,
            merchantOrderNo,
            planCode: selectedPlan.code,
            billingCycle,
            amount,
            payload: {
                MerchantID_: config.MerchantID,
                PostData_: tradeInfo
            }
        };
    }

    function verifyNewebpayTradeSha(payload = {}, config = {}) {
        const tradeInfo = String(payload.TradeInfo || payload.tradeInfo || '');
        const tradeSha = String(payload.TradeSha || payload.tradeSha || '').toUpperCase();
        if (!tradeInfo || !tradeSha) return false;
        const source = `HashKey=${config.HashKey}&${tradeInfo}&HashIV=${config.HashIV}`;
        const digest = crypto.createHash('sha256').update(source).digest('hex').toUpperCase();
        return digest === tradeSha;
    }

    /**
     * 藍新回傳碼可能是字串 "00" 或數字 0；讀取時必須用 ??，不可用 ||（0 會被當成 falsy）。
     * 僅將「單一數字」補成兩位（0→00），保留原有 '1' 成功判斷語意。
     */
    function normalizeNewebpayDigitsCode(value) {
        if (value === undefined || value === null) return '';
        const s = String(value).trim();
        if (!s) return '';
        if (/^\d$/.test(s)) return s.padStart(2, '0');
        return s;
    }

    function inferNewebpaySubscriptionStatus(payload = {}) {
        const rawStatus = String(
            payload.Status ?? payload.status ?? payload.PeriodStatus ?? payload.periodStatus ?? ''
        ).toUpperCase();
        const rtnCode = normalizeNewebpayDigitsCode(payload.RtnCode ?? payload.rtnCode);
        const respondCode = normalizeNewebpayDigitsCode(payload.RespondCode ?? payload.respondCode);
        const message = String(payload.Message ?? payload.message ?? payload.Msg ?? '').trim();
        if (!rawStatus && !rtnCode && !respondCode) return null;
        const isSuccessCode = rtnCode === '1' || rtnCode === '00' || respondCode === '00';
        // 手冊標準：Status=SUCCESS 且銀行回應碼成功(00/1) 才視為啟用
        if (rawStatus.includes('SUCCESS') && isSuccessCode) return 'active';
        // 建立委託成功回傳有時 Result 無法完整還原，改以明確成功訊息作次判斷（僅限 SUCCESS）
        if (rawStatus.includes('SUCCESS') && /委託單成立/.test(message) && /首次授權成功|授權成功/.test(message)) {
            return 'active';
        }
        if (rawStatus.includes('CANCEL')) return 'canceled';
        if (!rawStatus) return null;
        if (rawStatus) return 'past_due';
        return 'past_due';
    }

    function inferNewebpayPaymentStatus(payload = {}) {
        const rawStatus = String(
            payload.Status ?? payload.status ?? payload.PeriodStatus ?? payload.periodStatus ?? ''
        ).toUpperCase();
        const rtnCode = normalizeNewebpayDigitsCode(payload.RtnCode ?? payload.rtnCode);
        const respondCode = normalizeNewebpayDigitsCode(payload.RespondCode ?? payload.respondCode);
        const message = String(payload.Message ?? payload.message ?? payload.Msg ?? '').trim();
        if (!rawStatus && !rtnCode && !respondCode) return null;
        if (rawStatus.includes('SUCCESS') && (rtnCode === '1' || rtnCode === '00' || respondCode === '00')) {
            return 'success';
        }
        if (rawStatus.includes('SUCCESS') && /委託單成立/.test(message) && /首次授權成功|授權成功/.test(message)) {
            return 'success';
        }
        if (!rawStatus) return null;
        if (rawStatus) return 'failed';
        return 'failed';
    }

    function extractNewebpayFieldFromRawText(raw, fieldName) {
        const text = String(raw || '');
        if (!text) return '';
        const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patterns = [
            new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`, 'i'),
            new RegExp(`"${escaped}"\\s*:\\s*"?([A-Za-z0-9_\\-]+)"?`, 'i'),
            // 兼容 JSON.stringify 後的跳脫樣式：\\\"PeriodNo\\\":\\\"Pxxxx\\\"
            new RegExp(`\\\\+\"${escaped}\\\\+\"\\s*:\\s*\\\\+\"([^\"\\\\]+)\\\\+\"`, 'i'),
            new RegExp(`\\\\+\"${escaped}\\\\+\"\\s*:\\s*\\\\+\"?([A-Za-z0-9_\\-]+)`, 'i'),
            new RegExp(`${escaped}\\s*=>\\s*"([^"]+)"`, 'i'),
            new RegExp(`${escaped}\\s*=\\s*([A-Za-z0-9_\\-]+)`, 'i')
        ];
        for (const p of patterns) {
            const m = text.match(p);
            if (m && String(m[1] || '').trim()) return String(m[1] || '').trim();
        }
        return '';
    }

    function parseNewebpayDateValue(raw) {
        const text = String(raw || '').trim();
        if (!text) return null;
        const parsed = new Date(text);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
        const datetimeCompact = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
        if (datetimeCompact) {
            const dt = new Date(`${datetimeCompact[1]}-${datetimeCompact[2]}-${datetimeCompact[3]}T${datetimeCompact[4]}:${datetimeCompact[5]}:${datetimeCompact[6]}+08:00`);
            if (!Number.isNaN(dt.getTime())) return dt.toISOString();
        }
        const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (compact) {
            const dt = new Date(`${compact[1]}-${compact[2]}-${compact[3]}T00:00:00+08:00`);
            if (!Number.isNaN(dt.getTime())) return dt.toISOString();
        }
        return null;
    }

    function parseNewebpayDateArray(raw) {
        const candidates = [];
        if (Array.isArray(raw)) {
            candidates.push(raw);
        } else {
            const text = String(raw || '').trim();
            if (!text) return [];
            candidates.push(text);
            if (text.includes('\\"') || text.includes('\\\\')) {
                candidates.push(text.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
            }
        }

        for (const item of candidates) {
            if (Array.isArray(item)) {
                return item.map((v) => String(v || '').trim()).filter(Boolean);
            }
            const t = String(item || '').trim();
            if (!t) continue;
            try {
                const parsed = JSON.parse(t);
                if (Array.isArray(parsed)) {
                    return parsed.map((v) => String(v || '').trim()).filter(Boolean);
                }
                if (parsed && Array.isArray(parsed.DateArray)) {
                    return parsed.DateArray.map((v) => String(v || '').trim()).filter(Boolean);
                }
            } catch (_) {
                // ignore
            }
            const byComma = t.split(',').map((v) => v.trim()).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
            if (byComma.length > 0) return byComma;
        }
        return [];
    }

    function resolveTenantIdFromNewebpayPayload(payload = {}) {
        const direct = parseInt(payload.tenant_id || payload.tenantId || payload.TenantId, 10);
        if (Number.isInteger(direct) && direct > 0) return direct;
        const merchantOrderNo = String(
            payload.MerchantOrderNo ||
            payload.MerchAntOrderNo ||
            payload.merchantOrderNo ||
            payload.MerOrderNo ||
            payload.merOrderNo ||
            ''
        );
        const match = merchantOrderNo.match(/T(\d{1,10})/i);
        if (match) {
            const parsed = parseInt(match[1], 10);
            if (Number.isInteger(parsed) && parsed > 0) return parsed;
        }
        return null;
    }

    function pickFirstNonEmpty(...values) {
        for (const value of values) {
            const text = String(value || '').trim();
            if (text) return text;
        }
        return '';
    }

    function appendTenantIdToUrl(urlText, tenantId) {
        const base = String(urlText || '').trim();
        const safeTenantId = parseInt(tenantId, 10);
        if (!base || !Number.isInteger(safeTenantId) || safeTenantId <= 0) return base;
        try {
            const url = new URL(base);
            if (!url.searchParams.get('tenant_id')) {
                url.searchParams.set('tenant_id', String(safeTenantId));
            }
            return url.toString();
        } catch (_) {
            if (base.includes('tenant_id=')) return base;
            const sep = base.includes('?') ? '&' : '?';
            return `${base}${sep}tenant_id=${safeTenantId}`;
        }
    }

    function buildNewebpayBrowserReturnUrl(rawReturnUrl, tenantId) {
        const fallback = String(processEnv.NEWEBPAY_SUBSCRIPTION_BROWSER_RETURN_URL || '').trim();
        const base = String(rawReturnUrl || fallback).trim();
        const safeTenantId = parseInt(tenantId, 10);
        if (!base) return appendTenantIdToUrl('/api/payment/newebpay/subscription/return', safeTenantId);
        try {
            const url = new URL(base);
            const returnUrl = `${url.origin}/api/payment/newebpay/subscription/return`;
            return appendTenantIdToUrl(returnUrl, safeTenantId);
        } catch (_) {
            return appendTenantIdToUrl('/api/payment/newebpay/subscription/return', safeTenantId);
        }
    }

    function buildNewebpayWebhookNotifyUrl(rawNotifyUrl, rawReturnUrl, tenantId) {
        const safeTenantId = parseInt(tenantId, 10);
        const direct = String(rawNotifyUrl || '').trim();
        if (direct) return appendTenantIdToUrl(direct, safeTenantId);
        const returnBase = String(rawReturnUrl || '').trim();
        if (returnBase) {
            try {
                const url = new URL(returnBase);
                return appendTenantIdToUrl(`${url.origin}/api/payment/newebpay/subscription/webhook`, safeTenantId);
            } catch (_) {
                // ignore parse failure
            }
        }
        return appendTenantIdToUrl(String(processEnv.NEWEBPAY_SUBSCRIPTION_NOTIFY_URL || '').trim(), safeTenantId);
    }

    /**
     * 若 multipart 未正確建出 Period 欄位，但某欄位值為藍新 JSON 字串，補上 Period 供後續解析。
     */
    function coerceNewebpaySubscriptionBody(input) {
        const sanitizeJsonText = (value) => String(value || '').replace(/^[\uFEFF\u200B\u200C\u200D]+/, '').trim();
        const base = input && typeof input === 'object' ? { ...input } : {};
        if (String(base.Period || base.period || '').trim().length > 0) {
            return base;
        }
        for (const [key, val] of Object.entries(base)) {
            if (key === 'tenant_id' || key === 'tenantId' || key === 'TenantId') continue;
            const s = typeof val === 'string' ? sanitizeJsonText(val) : '';
            if (!s || s.charAt(0) !== '{') continue;
            try {
                const parsed = JSON.parse(s);
                if (
                    parsed && typeof parsed === 'object'
                    && !Array.isArray(parsed)
                    && (
                        parsed.Status != null
                        || parsed.RespondCode != null
                        || parsed.Result != null
                        || parsed.MerchantOrderNo != null
                        || parsed.MerchAntOrderNo != null
                        || parsed.PeriodNo != null
                    )
                ) {
                    return { ...base, Period: s };
                }
            } catch (_) {
                /* ignore */
            }
        }
        return base;
    }

    function recoverSingleJsonKeyObject(input) {
        const normalizeJsonLikeText = (value) => {
            let text = String(value || '').replace(/^[\uFEFF\u200B\u200C\u200D]+/, '').trim();
            if (!text) return '';
            try {
                if (text.includes('%')) text = decodeURIComponent(text);
            } catch (_) {
                // keep original text
            }
            // 若外層被包成字串（例如 "\"{\\\"Status\\\":...}\""），先拆外層引號
            if (
                (text.startsWith('"') && text.endsWith('"'))
                || (text.startsWith("'") && text.endsWith("'"))
            ) {
                text = text.slice(1, -1).trim();
            }
            return text;
        };
        if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
        const keys = Object.keys(input);
        if (keys.length !== 1) return input;
        const onlyKey = normalizeJsonLikeText(keys[0]);
        if (!onlyKey) return input;

        const isJsonLike = (
            (onlyKey.startsWith('{') && onlyKey.endsWith('}'))
            || (onlyKey.startsWith('[{') && onlyKey.endsWith('}]'))
            || (onlyKey.includes('\\"Status\\"') || onlyKey.includes('\\"Result\\"'))
        );
        if (!isJsonLike) return input;

        const recovered = tryParseNewebpayPayloadWithoutDecrypt(onlyKey);
        if (recovered && typeof recovered === 'object' && !Array.isArray(recovered)) {
            return recovered;
        }
        // 最後再嘗試一次反跳脫後解析（避免 key 內還保留 \\"）
        const unescaped = onlyKey.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const recoveredUnescaped = tryParseNewebpayPayloadWithoutDecrypt(unescaped);
        if (recoveredUnescaped && typeof recoveredUnescaped === 'object' && !Array.isArray(recoveredUnescaped)) {
            return recoveredUnescaped;
        }
        return input;
    }

    function forceNormalizeNewebpayStatusSource(input) {
        const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
        const hasDirectStatus = (
            source.Status != null
            || source.status != null
            || source.RtnCode != null
            || source.rtnCode != null
            || source.RespondCode != null
            || source.respondCode != null
            || source.Message != null
            || source.message != null
            || source.Msg != null
        );
        if (hasDirectStatus) return source;

        const keys = Object.keys(source);
        if (keys.length !== 1) return source;

        const keyText = String(keys[0] || '');
        const valueText = String(source[keys[0]] || '');
        const candidates = [keyText, valueText, `${keyText}${valueText}`];

        const extractObjectText = (text) => {
            const raw = String(text || '').replace(/^[\uFEFF\u200B\u200C\u200D]+/, '').trim();
            if (!raw) return '';
            const m = raw.match(/\{[\s\S]*\}/);
            return m ? m[0] : raw;
        };

        const tryDecode = (text) => {
            let t = extractObjectText(text);
            if (!t) return null;
            for (let i = 0; i < 2; i += 1) {
                const recovered = tryParseNewebpayPayloadWithoutDecrypt(t);
                if (recovered && typeof recovered === 'object' && !Array.isArray(recovered)) {
                    return recovered;
                }
                t = t.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
            return null;
        };

        for (const c of candidates) {
            const decoded = tryDecode(c);
            if (decoded) return decoded;
        }
        return source;
    }

    function inferNewebpayStatusFromRawText(...parts) {
        const joined = parts
            .map((p) => String(p || ''))
            .filter((p) => p.trim().length > 0)
            .join(' ');
        if (!joined.trim()) return { subscriptionStatus: null, paymentStatus: null };

        // 不依賴 JSON parse，直接掃描原始字串特徵，避免被奇怪包裝卡死。
        const hasSuccessStatus = /"Status"\s*:\s*"SUCCESS"/i.test(joined) || /Status\s*=\s*SUCCESS/i.test(joined);
        const hasSuccessCode = /"RespondCode"\s*:\s*"?0{1,2}"?/i.test(joined)
            || /"RtnCode"\s*:\s*"?0{1,2}"?/i.test(joined)
            || /RespondCode\s*=\s*0{1,2}/i.test(joined)
            || /RtnCode\s*=\s*0{1,2}/i.test(joined);
        const hasReference = /"PeriodNo"\s*:\s*"[^"]+"/i.test(joined)
            || /"MerchantOrderNo"\s*:\s*"[^"]+"/i.test(joined)
            || /"MerOrderNo"\s*:\s*"[^"]+"/i.test(joined)
            || /PeriodNo\s*=\s*[A-Za-z0-9_]+/i.test(joined)
            || /MerchantOrderNo\s*=\s*[A-Za-z0-9_]+/i.test(joined)
            || /MerOrderNo\s*=\s*[A-Za-z0-9_]+/i.test(joined);
        const hasFailedStatus = /"Status"\s*:\s*"FAILED"/i.test(joined) || /Status\s*=\s*FAILED/i.test(joined);
        const hasCancelStatus = /"Status"\s*:\s*"CANCEL/i.test(joined) || /Status\s*=\s*CANCEL/i.test(joined);

        if (hasSuccessStatus && hasSuccessCode && hasReference) {
            return { subscriptionStatus: 'active', paymentStatus: 'success' };
        }
        if (hasCancelStatus) {
            return { subscriptionStatus: 'canceled', paymentStatus: 'failed' };
        }
        if (hasFailedStatus) {
            return { subscriptionStatus: 'past_due', paymentStatus: 'failed' };
        }
        return { subscriptionStatus: null, paymentStatus: null };
    }

    function isNewebpayRawFallbackEnabled() {
        const v = String(processEnv.NEWEBPAY_ENABLE_RAW_FALLBACK || 'false').trim().toLowerCase();
        return v !== 'false' && v !== '0' && v !== 'off';
    }

    async function handleNewebpaySubscriptionWebhook(rawPayload = {}, context = {}) {
        const reqBody = coerceNewebpaySubscriptionBody(rawPayload);
        const tenantHint = resolveTenantIdFromNewebpayPayload(reqBody)
            || parseInt(context?.queryTenantId, 10)
            || defaultTenantId;
        const fallbackTenantIds = [tenantHint, parseInt(context?.queryTenantId, 10), defaultTenantId]
            .filter((id) => Number.isInteger(id) && id > 0)
            .filter((id, idx, arr) => arr.indexOf(id) === idx);
        if (typeof db.getTenantsOverview === 'function') {
            try {
                const tenantOverview = await db.getTenantsOverview({ limit: 200, offset: 0 });
                const tenantIds = Array.isArray(tenantOverview?.items)
                    ? tenantOverview.items.map((item) => parseInt(item?.id, 10)).filter((id) => Number.isInteger(id) && id > 0)
                    : [];
                tenantIds.forEach((id) => {
                    if (!fallbackTenantIds.includes(id)) fallbackTenantIds.push(id);
                });
            } catch (_) {
                // ignore candidate lookup failure
            }
        }
        const decryptWithTenantFallback = async (encryptedValue, fieldName) => {
            let lastError = null;
            for (const candidateTenantId of fallbackTenantIds) {
                try {
                    const candidateConfig = await getNewebpayConfigFromSettings(['HashKey', 'HashIV'], candidateTenantId);
                    const decrypted = decryptNewebpayPayload(encryptedValue, candidateConfig, fieldName);
                    return { decrypted, config: candidateConfig };
                } catch (error) {
                    lastError = error;
                }
            }
            throw lastError || new Error(`無法解密藍新 ${fieldName} 內容`);
        };
        let config = await getNewebpayConfigFromSettings(['HashKey', 'HashIV'], tenantHint);
        const encryptedPeriod = String(reqBody.Period || reqBody.period || '').trim();
        const encryptedTradeInfo = String(reqBody.TradeInfo || reqBody.tradeInfo || '').trim();
        if (encryptedTradeInfo && reqBody.TradeSha) {
            const validTradeSha = verifyNewebpayTradeSha(reqBody, config);
            if (!validTradeSha) {
                throw new Error('藍新 webhook 驗簽失敗（TradeSha 不一致）');
            }
        }
        let periodPayload = {};
        if (encryptedPeriod) {
            const tryPlainFirst = !isLikelyNewebpayPeriodCipherHex(encryptedPeriod);
            if (tryPlainFirst) {
                const directParsed = tryParseNewebpayPayloadWithoutDecrypt(encryptedPeriod);
                if (directParsed) {
                    periodPayload = directParsed;
                    logPaymentEvent('info', 'payment.newebpay.subscription.direct_plain_period', {
                        requestId: context.requestId || null,
                        tenantHint,
                        result: 'parsed_plain_json'
                    });
                }
            }
            if (!periodPayload || Object.keys(periodPayload).length === 0) {
                try {
                    const decryptedResult = await decryptWithTenantFallback(encryptedPeriod, 'Period');
                    config = decryptedResult.config || config;
                    const decrypted = decryptedResult.decrypted;
                    periodPayload = parseNewebpayPeriodPayload(decrypted);
                } catch (decryptError) {
                    const fallbackParsed = tryParseNewebpayPayloadWithoutDecrypt(encryptedPeriod);
                    if (!fallbackParsed) throw decryptError;
                    periodPayload = fallbackParsed;
                    logPaymentEvent('warn', 'payment.newebpay.subscription.fallback_plain_period', {
                        requestId: context.requestId || null,
                        tenantHint,
                        result: 'parsed_without_decrypt_after_fail'
                    });
                }
            }
        } else if (encryptedTradeInfo) {
            const tryTradePlainFirst = !isLikelyNewebpayPeriodCipherHex(encryptedTradeInfo);
            if (tryTradePlainFirst) {
                const directTrade = tryParseNewebpayPayloadWithoutDecrypt(encryptedTradeInfo);
                if (directTrade) {
                    periodPayload = directTrade;
                    logPaymentEvent('info', 'payment.newebpay.subscription.direct_plain_tradeinfo', {
                        requestId: context.requestId || null,
                        tenantHint,
                        result: 'parsed_plain_json'
                    });
                }
            }
            if (!periodPayload || Object.keys(periodPayload).length === 0) {
                try {
                    const decryptedResult = await decryptWithTenantFallback(encryptedTradeInfo, 'TradeInfo');
                    config = decryptedResult.config || config;
                    const decrypted = decryptedResult.decrypted;
                    periodPayload = parseNewebpayPeriodPayload(decrypted);
                } catch (decryptError) {
                    const fallbackParsed = tryParseNewebpayPayloadWithoutDecrypt(encryptedTradeInfo);
                    if (!fallbackParsed) throw decryptError;
                    periodPayload = fallbackParsed;
                    logPaymentEvent('warn', 'payment.newebpay.subscription.fallback_plain_tradeinfo', {
                        requestId: context.requestId || null,
                        tenantHint,
                        result: 'parsed_without_decrypt_after_fail'
                    });
                }
            }
        } else if (reqBody && typeof reqBody === 'object' && Object.keys(reqBody).length > 0) {
            periodPayload = reqBody;
            if (typeof periodPayload.Result === 'string') {
                try {
                    periodPayload.Result = JSON.parse(periodPayload.Result);
                } catch (_) {
                    // keep original string when not JSON
                }
            }
        } else {
            throw new Error('缺少藍新回傳 Period/TradeInfo 參數');
        }
        // 最後保底：某些回傳會變成 { '{"Status":"SUCCESS",...}': '...' }，此時先還原再做狀態推斷。
        periodPayload = recoverSingleJsonKeyObject(periodPayload);
        function extractNewebpayPeriodResultForNested(periodObj) {
            const pp = periodObj && typeof periodObj === 'object' ? periodObj : {};
            let inner = pp.Result;
            if (typeof inner === 'string') {
                const candidates = [inner];
                const trimmed = String(inner || '').trim();
                if (
                    (trimmed.startsWith('"') && trimmed.endsWith('"'))
                    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
                ) {
                    candidates.push(trimmed.slice(1, -1));
                }
                candidates.push(trimmed.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
                for (const candidate of candidates) {
                    try {
                        const parsed = JSON.parse(String(candidate || '').trim());
                        inner = parsed;
                        if (typeof inner === 'string') {
                            // Result 可能是被包了兩層字串，繼續嘗試展開
                            const nested = JSON.parse(String(inner || '').trim());
                            inner = nested;
                        }
                        break;
                    } catch (_) {
                        // try next candidate
                    }
                    // JSON.parse 失敗時，改用既有容錯解析（支援單一 key / urlencoded / 跳脫字串）
                    const recovered = tryParseNewebpayPayloadWithoutDecrypt(String(candidate || '').trim());
                    if (recovered && typeof recovered === 'object' && !Array.isArray(recovered)) {
                        inner = recovered;
                        break;
                    }
                }
            }
            if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
                return recoverSingleJsonKeyObject(inner);
            }
            if (Array.isArray(inner) && inner.length > 0 && inner[0] && typeof inner[0] === 'object' && !Array.isArray(inner[0])) {
                return recoverSingleJsonKeyObject(inner[0]);
            }
            return {};
        }

        const resultPayload = extractNewebpayPeriodResultForNested(periodPayload);
        // 推斷訂閱狀態時必須合併頂層與 Result 內層：藍新常把 Status 放在外層，細節與 RespondCode 在內層
        const statusSource = forceNormalizeNewebpayStatusSource({
            ...(periodPayload && typeof periodPayload === 'object' ? periodPayload : {}),
            ...(resultPayload && typeof resultPayload === 'object' ? resultPayload : {})
        });
        const rawJoinedText = [
            JSON.stringify(reqBody || {}),
            JSON.stringify(periodPayload || {}),
            JSON.stringify(resultPayload || {})
        ].join(' ');
        if (!statusSource.RespondCode && !statusSource.respondCode) {
            const recoveredRespondCode = extractNewebpayFieldFromRawText(rawJoinedText, 'RespondCode');
            if (recoveredRespondCode) statusSource.RespondCode = recoveredRespondCode;
        }
        if (!statusSource.PeriodNo && !statusSource.periodNo) {
            const recoveredPeriodNo = extractNewebpayFieldFromRawText(rawJoinedText, 'PeriodNo');
            if (recoveredPeriodNo) statusSource.PeriodNo = recoveredPeriodNo;
        }
        if (!statusSource.MerchantOrderNo && !statusSource.merchantOrderNo) {
            const recoveredMerchantOrderNo = extractNewebpayFieldFromRawText(rawJoinedText, 'MerchantOrderNo')
                || extractNewebpayFieldFromRawText(rawJoinedText, 'MerOrderNo');
            if (recoveredMerchantOrderNo) statusSource.MerchantOrderNo = recoveredMerchantOrderNo;
        }

        let tenantId = resolveTenantIdFromNewebpayPayload({
            ...reqBody,
            ...periodPayload,
            ...resultPayload
        });
        if (!tenantId) {
            const tenantFromQuery = parseInt(context?.queryTenantId, 10);
            if (Number.isInteger(tenantFromQuery) && tenantFromQuery > 0) {
                tenantId = tenantFromQuery;
            }
        }
        if (!tenantId && typeof db.resolveTenantIdByRecurringReference === 'function') {
            const merOrderNo = pickFirstNonEmpty(
                resultPayload.MerchantOrderNo,
                resultPayload.MerchAntOrderNo,
                resultPayload.merchantOrderNo,
                resultPayload.MerOrderNo,
                resultPayload.merOrderNo,
                periodPayload.MerchantOrderNo,
                periodPayload.MerchAntOrderNo,
                periodPayload.merchantOrderNo,
                periodPayload.MerOrderNo,
                periodPayload.merOrderNo,
                reqBody.MerchantOrderNo,
                reqBody.MerchAntOrderNo,
                reqBody.merchantOrderNo,
                reqBody.MerOrderNo,
                reqBody.merOrderNo
            );
            const periodNo = pickFirstNonEmpty(
                resultPayload.PeriodNo,
                resultPayload.periodNo,
                periodPayload.PeriodNo,
                periodPayload.periodNo,
                reqBody.PeriodNo,
                reqBody.periodNo
            );
            tenantId = await db.resolveTenantIdByRecurringReference({
                provider: 'newebpay',
                providerOrderNo: merOrderNo || null,
                providerSubscriptionId: periodNo || null
            });
        }
        if (!tenantId) {
            throw new Error('無法從藍新 webhook 解析 tenant_id');
        }

        const baseEventId = String(
            reqBody.TradeNo ||
            reqBody.tradeNo ||
            resultPayload.TradeNo ||
            resultPayload.tradeNo ||
            reqBody.PeriodNo ||
            reqBody.periodNo ||
            resultPayload.PeriodNo ||
            resultPayload.periodNo ||
            reqBody.MerchantOrderNo ||
            reqBody.merchantOrderNo ||
            resultPayload.MerchantOrderNo ||
            resultPayload.merchantOrderNo ||
            resultPayload.MerOrderNo ||
            resultPayload.merOrderNo ||
            context.requestId ||
            Date.now()
        ).trim();
        const eventStatusPart = String(
            resultPayload.Status ||
            resultPayload.status ||
            periodPayload.Status ||
            periodPayload.status ||
            reqBody.Status ||
            reqBody.status ||
            'unknown'
        ).trim().toLowerCase();
        const eventCodePart = String(
            resultPayload.RtnCode ||
            resultPayload.rtnCode ||
            resultPayload.RespondCode ||
            resultPayload.respondCode ||
            periodPayload.RtnCode ||
            periodPayload.rtnCode ||
            periodPayload.RespondCode ||
            periodPayload.respondCode ||
            reqBody.RtnCode ||
            reqBody.rtnCode ||
            reqBody.RespondCode ||
            reqBody.respondCode ||
            ''
        ).trim();
        // Keep retries idempotent while allowing state transitions on same PeriodNo.
        const eventId = `${baseEventId}:${eventStatusPart}:${eventCodePart || 'na'}`;
        const eventType = String(reqBody.EventType || reqBody.eventType || 'subscription.renewal');
        if (!context?.forceProcessExisting) {
            const saveResult = await db.insertPaymentEventIfAbsent({
                tenantId,
                provider: 'newebpay',
                eventId,
                eventType,
                payload: {
                    rawPayload: reqBody,
                    period: periodPayload
                },
                signature: encryptedPeriod || encryptedTradeInfo
            });
            if (!saveResult.inserted) {
                return { duplicate: true, tenantId, eventId };
            }
        }

        const status = inferNewebpaySubscriptionStatus(statusSource);
        const paymentStatus = inferNewebpayPaymentStatus(statusSource);
        const rawFallback = isNewebpayRawFallbackEnabled()
            ? inferNewebpayStatusFromRawText(
                rawJoinedText
            )
            : { subscriptionStatus: null, paymentStatus: null };
        const usedRawFallback = (!status && !paymentStatus) && !!(rawFallback.subscriptionStatus || rawFallback.paymentStatus);
        const resolvedStatus = status || rawFallback.subscriptionStatus || null;
        const resolvedPaymentStatus = paymentStatus || rawFallback.paymentStatus || null;
        const statusPeriodNo = pickFirstNonEmpty(
            resultPayload.PeriodNo,
            resultPayload.periodNo,
            periodPayload.PeriodNo,
            periodPayload.periodNo,
            reqBody.PeriodNo,
            reqBody.periodNo
        );
        const statusTradeNo = pickFirstNonEmpty(
            resultPayload.TradeNo,
            resultPayload.tradeNo,
            periodPayload.TradeNo,
            periodPayload.tradeNo,
            reqBody.TradeNo,
            reqBody.tradeNo
        );
        const statusOrderNo = pickFirstNonEmpty(
            resultPayload.OrderNo,
            resultPayload.orderNo,
            periodPayload.OrderNo,
            periodPayload.orderNo,
            reqBody.OrderNo,
            reqBody.orderNo
        );
        const hasRecurringReference = !!(statusPeriodNo || statusTradeNo || statusOrderNo);
        const isDowngradeSignal = resolvedStatus === 'past_due' || resolvedStatus === 'canceled' || resolvedPaymentStatus === 'failed';
        // 避免把建立委託/參數錯誤類事件（如 PER10010）誤判成訂閱扣款失敗，覆蓋啟用中狀態。
        if (isDowngradeSignal && !hasRecurringReference) {
            logPaymentEvent('warn', 'payment.newebpay.subscription.ignored_non_recurring_failure', {
                requestId: context.requestId || null,
                tenantId,
                eventId,
                rawStatus: String(statusSource?.Status ?? statusSource?.status ?? ''),
                respondCode: String(statusSource?.RespondCode ?? statusSource?.respondCode ?? ''),
                result: 'ignored'
            });
            return { duplicate: false, ignored: true, tenantId, eventId };
        }

        if (!resolvedStatus && !resolvedPaymentStatus) {
            logPaymentEvent('warn', 'payment.newebpay.subscription.ignored_empty_status', {
                requestId: context.requestId || null,
                tenantId,
                eventId,
                bodyKeys: Object.keys(statusSource || {}),
                result: 'ignored'
            });
            return { duplicate: false, ignored: true, tenantId, eventId };
        }
        let nextBillingAt = parseNewebpayDateValue(
            resultPayload.NextAuthDate ||
            resultPayload.nextAuthDate ||
            resultPayload.NewNextTime ||
            resultPayload.newNextTime ||
            resultPayload.AuthDate ||
            resultPayload.authDate ||
            resultPayload.NextPeriodDate ||
            resultPayload.NextPeriod ||
            periodPayload.NextAuthDate ||
            periodPayload.nextAuthDate ||
            periodPayload.NewNextTime ||
            periodPayload.newNextTime ||
            periodPayload.AuthDate ||
            periodPayload.authDate ||
            periodPayload.NextPeriodDate ||
            periodPayload.NextPeriod
        );
        let periodEnd = nextBillingAt || parseNewebpayDateValue(
            resultPayload.PeriodEndDate ||
            resultPayload.PeriodEnd ||
            resultPayload.NextAuthDate ||
            resultPayload.NewNextTime ||
            periodPayload.PeriodEndDate ||
            periodPayload.PeriodEnd ||
            periodPayload.NextAuthDate ||
            periodPayload.NewNextTime
        );
        if (!nextBillingAt || !periodEnd) {
            const recoveredDateArrayFromRaw = extractNewebpayFieldFromRawText(rawJoinedText, 'DateArray')
                || extractNewebpayFieldFromRawText(rawJoinedText, 'scheduleDates');
            const dateArrayRaw = (
                resultPayload.DateArray
                || resultPayload.dateArray
                || periodPayload.DateArray
                || periodPayload.dateArray
                || statusSource.DateArray
                || statusSource.dateArray
                || recoveredDateArrayFromRaw
            );
            const dateArray = parseNewebpayDateArray(dateArrayRaw);
            if (dateArray.length > 0) {
                const nowMs = Date.now();
                const parsedDates = dateArray
                    .map((d) => parseNewebpayDateValue(d))
                    .filter(Boolean)
                    .map((iso) => new Date(iso))
                    .filter((d) => !Number.isNaN(d.getTime()))
                    .sort((a, b) => a.getTime() - b.getTime());
                if (parsedDates.length > 0) {
                    const future = parsedDates.find((d) => d.getTime() > nowMs) || parsedDates[0];
                    if (!nextBillingAt) {
                        nextBillingAt = future.toISOString();
                    }
                    if (!periodEnd) {
                        // UI 的「到期時間」以最近一期為準（非整張委託最後一期），避免月繳顯示成近一年後
                        periodEnd = future.toISOString();
                    }
                }
            }
        }
        if (resolvedStatus === 'active' && nextBillingAt) {
            // 以藍新排程為準：下次扣款日期直接採用 NextAuthDate/DateArray 推導結果
            periodEnd = nextBillingAt;
        }
        if (!periodEnd && resolvedStatus === 'active' && typeof db.getTenantSubscriptionSnapshot === 'function') {
            try {
                const currentSnapshot = await db.getTenantSubscriptionSnapshot(tenantId);
                const cycle = String(currentSnapshot?.billingCycle || '').toLowerCase();
                const base = new Date();
                if (cycle === 'yearly' || cycle === 'year') base.setFullYear(base.getFullYear() + 1);
                else base.setMonth(base.getMonth() + 1);
                periodEnd = base.toISOString();
                if (!nextBillingAt) nextBillingAt = periodEnd;
            } catch (_) {
                // ignore period fallback failure
            }
        }
        const providerSubscriptionIdCanonical = pickFirstNonEmpty(
            resultPayload.PeriodNo,
            resultPayload.periodNo,
            periodPayload.PeriodNo,
            periodPayload.periodNo,
            statusSource.PeriodNo,
            statusSource.periodNo,
            extractNewebpayFieldFromRawText(rawJoinedText, 'PeriodNo')
        );
        const providerOrderNoCanonical = pickFirstNonEmpty(
            resultPayload.MerchantOrderNo,
            resultPayload.MerchAntOrderNo,
            resultPayload.MerOrderNo,
            periodPayload.MerchantOrderNo,
            periodPayload.MerchAntOrderNo,
            periodPayload.MerOrderNo,
            statusSource.MerchantOrderNo,
            statusSource.merchantOrderNo,
            extractNewebpayFieldFromRawText(rawJoinedText, 'MerchantOrderNo'),
            extractNewebpayFieldFromRawText(rawJoinedText, 'MerOrderNo')
        );
        const snapshot = await db.updateTenantSubscriptionRecurringState(tenantId, {
            provider: 'newebpay',
            providerSubscriptionId: providerSubscriptionIdCanonical || null,
            providerCustomerId: resultPayload.PayerEmail || resultPayload.Email || periodPayload.PayerEmail || periodPayload.Email || null,
            providerOrderNo: providerOrderNoCanonical || null,
            paymentStatus: resolvedPaymentStatus,
            subscriptionStatus: resolvedStatus,
            nextBillingAt,
            nextPeriodEnd: periodEnd
        });
        logPaymentEvent('info', 'payment.newebpay.subscription.synced', {
            requestId: context.requestId || null,
            tenantId,
            eventId,
            status: resolvedStatus,
            result: 'ok'
        });
        return { duplicate: false, tenantId, eventId, status: resolvedStatus, snapshot };
    }

    async function alterNewebpaySubscriptionStatus(params = {}) {
        const {
            tenantId,
            merOrderNo,
            periodNo,
            alterType
        } = params;
        if (!merOrderNo || !periodNo || !alterType) {
            throw new Error('缺少必要欄位：merOrderNo、periodNo、alterType');
        }

        const normalizedAlterType = String(alterType).toLowerCase();
        if (!['suspend', 'restart', 'terminate'].includes(normalizedAlterType)) {
            throw new Error('alterType 僅接受 suspend、restart、terminate');
        }

        const safeTenantId = parseInt(tenantId, 10) || defaultTenantId;
        const config = await getNewebpayConfigFromSettings(['MerchantID', 'HashKey', 'HashIV'], safeTenantId);
        const isProduction = Boolean(config.isProduction);
        const actionUrl = isProduction
            ? 'https://core.newebpay.com/MPG/period/AlterStatus'
            : 'https://ccore.newebpay.com/MPG/period/AlterStatus';

        const data = {
            RespondType: 'JSON',
            Version: '1.0',
            TimeStamp: String(Math.floor(Date.now() / 1000)),
            MerOrderNo: String(merOrderNo),
            PeriodNo: String(periodNo),
            AlterType: normalizedAlterType
        };
        const postData = encryptNewebpayTradeInfo(data, config);
        const responsePayload = await postNewebpayPeriodApi(actionUrl, {
            MerchantID_: config.MerchantID,
            PostData_: postData
        });
        const encryptedPeriod = responsePayload.Period || responsePayload.period;
        if (!encryptedPeriod) {
            throw new Error('藍新 AlterStatus 回應缺少 Period');
        }
        const decrypted = decryptNewebpayPeriod(encryptedPeriod, config);
        const result = parseNewebpayPeriodPayload(decrypted);
        let nestedResult = result?.Result;
        if (typeof nestedResult === 'string') {
            try {
                nestedResult = JSON.parse(nestedResult);
            } catch (_) {
                nestedResult = null;
            }
        }
        const normalizedStatus = String(
            result?.Status
            || nestedResult?.Status
            || result?.status
            || nestedResult?.status
            || ''
        ).toUpperCase();
        const normalizedCode = String(
            result?.RtnCode
            || nestedResult?.RtnCode
            || result?.RespondCode
            || nestedResult?.RespondCode
            || result?.rtnCode
            || nestedResult?.rtnCode
            || result?.respondCode
            || nestedResult?.respondCode
            || ''
        ).trim().padStart(2, '0');
        const normalizedMessage = String(
            result?.Message
            || nestedResult?.Message
            || result?.message
            || nestedResult?.message
            || ''
        ).trim();
        const isSuccess = normalizedStatus === 'SUCCESS'
            || normalizedCode === '00';
        if (!isSuccess) {
            throw new Error(normalizedMessage || normalizedStatus || '修改委託狀態失敗');
        }
        return result;
    }

    async function alterNewebpaySubscriptionContent(params = {}) {
        const {
            tenantId,
            merOrderNo,
            periodNo,
            alterAmt,
            periodType,
            periodPoint,
            periodTimes,
            extday,
            notifyUrl
        } = params;
        if (!merOrderNo || !periodNo) {
            throw new Error('缺少必要欄位：merOrderNo、periodNo');
        }

        const data = {
            RespondType: 'JSON',
            Version: '1.2',
            TimeStamp: String(Math.floor(Date.now() / 1000)),
            MerOrderNo: String(merOrderNo),
            PeriodNo: String(periodNo)
        };

        if (alterAmt !== undefined && alterAmt !== null && String(alterAmt) !== '') data.AlterAmt = String(alterAmt);
        if (periodType) data.PeriodType = String(periodType).toUpperCase();
        if (periodPoint) data.PeriodPoint = String(periodPoint);
        if (periodTimes !== undefined && periodTimes !== null && String(periodTimes) !== '') data.PeriodTimes = String(periodTimes);
        if (extday) data.Extday = String(extday);
        if (notifyUrl) data.NotifyURL = String(notifyUrl);

        if (!data.AlterAmt && !data.PeriodType && !data.PeriodPoint && !data.PeriodTimes && !data.Extday && !data.NotifyURL) {
            throw new Error('至少需提供一個可修改欄位：alterAmt/periodType/periodPoint/periodTimes/extday/notifyUrl');
        }

        const safeTenantId = parseInt(tenantId, 10) || defaultTenantId;
        const config = await getNewebpayConfigFromSettings(['MerchantID', 'HashKey', 'HashIV'], safeTenantId);
        const isProduction = Boolean(config.isProduction);
        const actionUrl = isProduction
            ? 'https://core.newebpay.com/MPG/period/AlterAmt'
            : 'https://ccore.newebpay.com/MPG/period/AlterAmt';

        const postData = encryptNewebpayTradeInfo(data, config);
        const responsePayload = await postNewebpayPeriodApi(actionUrl, {
            MerchantID_: config.MerchantID,
            PostData_: postData
        });
        const encryptedPeriod = responsePayload.Period || responsePayload.period;
        if (!encryptedPeriod) {
            throw new Error('藍新 AlterAmt 回應缺少 Period');
        }
        const decrypted = decryptNewebpayPeriod(encryptedPeriod, config);
        const result = parseNewebpayPeriodPayload(decrypted);
        let nestedResult = result?.Result;
        if (typeof nestedResult === 'string') {
            try {
                nestedResult = JSON.parse(nestedResult);
            } catch (_) {
                nestedResult = null;
            }
        }
        const normalizedStatus = String(
            result?.Status
            || nestedResult?.Status
            || result?.status
            || nestedResult?.status
            || ''
        ).toUpperCase();
        const normalizedCode = String(
            result?.RtnCode
            || nestedResult?.RtnCode
            || result?.RespondCode
            || nestedResult?.RespondCode
            || result?.rtnCode
            || nestedResult?.rtnCode
            || result?.respondCode
            || nestedResult?.respondCode
            || ''
        ).trim().padStart(2, '0');
        const normalizedMessage = String(
            result?.Message
            || nestedResult?.Message
            || result?.message
            || nestedResult?.message
            || ''
        ).trim();
        const isSuccess = normalizedStatus === 'SUCCESS'
            || normalizedCode === '00';
        if (!isSuccess) {
            throw new Error(normalizedMessage || normalizedStatus || '修改委託內容失敗');
        }
        return result;
    }

    async function reconcileRecentNewebpayEvents(options = {}) {
        const hours = Math.max(1, Math.min(168, parseInt(options.hours, 10) || 24));
        const limit = Math.max(1, Math.min(1000, parseInt(options.limit, 10) || 200));
        if (typeof db.getRecentPaymentEvents !== 'function') {
            return { scanned: 0, synced: 0, errors: 0 };
        }
        const events = await db.getRecentPaymentEvents({ provider: 'newebpay', hours, limit });
        let synced = 0;
        let errors = 0;
        for (const evt of events) {
            try {
                const payload = (evt?.payload && typeof evt.payload === 'object') ? evt.payload : {};
                const rawBase = (payload.rawPayload && typeof payload.rawPayload === 'object')
                    ? payload.rawPayload
                    : {};
                const periodSnap = (payload.period && typeof payload.period === 'object') ? payload.period : null;
                const rawPayload = {
                    ...(evt.tenantId ? { tenant_id: evt.tenantId } : {}),
                    ...rawBase,
                    ...(periodSnap || {})
                };
                if (!rawPayload || typeof rawPayload !== 'object' || Object.keys(rawPayload).length === 0) continue;
                const result = await handleNewebpaySubscriptionWebhook(rawPayload, {
                    requestId: `reconcile-${evt.id || 'event'}`,
                    queryTenantId: evt.tenantId || null,
                    forceProcessExisting: true
                });
                if (!result?.duplicate && !result?.ignored) synced += 1;
            } catch (error) {
                errors += 1;
                logPaymentEvent('warn', 'payment.newebpay.reconcile.event_failed', {
                    eventId: evt?.eventId || null,
                    tenantId: evt?.tenantId || null,
                    error: error?.message || String(error)
                });
            }
        }
        return { scanned: events.length, synced, errors };
    }

    async function handleCardPaymentSuccessByCallback(bookingId, context = {}) {
        if (!bookingId) {
            throw new Error('缺少 bookingId，無法處理付款成功回調');
        }

        logPaymentEvent('info', 'payment.callback.process.start', {
            requestId: context.requestId || null,
            route: '/api/payment/return',
            bookingId: bookingId,
            tradeNo: context.tradeNo || null,
            result: 'processing'
        });

        let tenantId = context.tenantId || context.subdomainTenantId;
        if (!tenantId && typeof db.resolveTenantIdByBookingId === 'function') {
            tenantId = await db.resolveTenantIdByBookingId(bookingId);
        }

        const booking = tenantId ? await db.getBookingById(bookingId, tenantId) : null;
        if (!booking) {
            logPaymentEvent('error', 'ALERT_PAYMENT_CALLBACK_BOOKING_NOT_FOUND', {
                requestId: context.requestId || null,
                route: '/api/payment/return',
                bookingId: bookingId,
                tradeNo: context.tradeNo || null,
                tenantId: tenantId || null,
                result: 'failed'
            });
            throw new Error(`找不到訂房記錄: ${bookingId}`);
        }

        if (booking.payment_status === 'paid') {
            logPaymentEvent('info', 'payment.callback.idempotent_skip', {
                requestId: context.requestId || null,
                route: '/api/payment/return',
                bookingId: bookingId,
                tradeNo: context.tradeNo || null,
                result: 'already_processed'
            });
            return { alreadyProcessed: true };
        }

        await db.updateBooking(bookingId, {
            payment_status: 'paid',
            status: 'active'
        }, tenantId);
        console.log('✅ 付款狀態已更新為「已付款」，訂房狀態已更新為「有效」');

        if (!(booking.payment_method && booking.payment_method.includes('刷卡'))) {
            logPaymentEvent('info', 'payment.callback.process.done', {
                requestId: context.requestId || null,
                route: '/api/payment/return',
                bookingId: bookingId,
                tradeNo: context.tradeNo || null,
                result: 'paid_updated_non_card'
            });
            return { alreadyProcessed: false };
        }

        await notificationService.sendCardPaymentSuccessNotifications(booking);

        logPaymentEvent('info', 'payment.callback.process.done', {
            requestId: context.requestId || null,
            route: '/api/payment/return',
            bookingId: bookingId,
            tradeNo: context.tradeNo || null,
            result: 'paid_updated_notified'
        });
        return { alreadyProcessed: false };
    }

    return {
        getEcpayConfigFromSettings,
        handleCardPaymentSuccessByCallback,
        getNewebpayConfigFromSettings,
        handleNewebpaySubscriptionWebhook,
        reconcileRecentNewebpayEvents,
        createNewebpaySubscriptionRequest,
        alterNewebpaySubscriptionStatus,
        alterNewebpaySubscriptionContent
    };
}

module.exports = {
    createPaymentService
};
