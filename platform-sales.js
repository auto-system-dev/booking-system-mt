(function () {
    const HERO_VARIANT_KEY = 'platform_hero_variant_v1';
    const form = document.getElementById('tenantSignupForm');
    const formMessage = document.getElementById('formMessage');
    if (!form || !formMessage) return;

    function resolveMeasurementId() {
        const meta = document.querySelector('meta[name="ga4-measurement-id"]');
        return String(meta?.content || '').trim();
    }

    function loadGa4IfNeeded() {
        const measurementId = resolveMeasurementId();
        if (!measurementId || !/^G-[A-Z0-9]+$/i.test(measurementId)) return '';
        if (!window.dataLayer) window.dataLayer = [];
        if (typeof window.gtag !== 'function') {
            window.gtag = function gtag() {
                window.dataLayer.push(arguments);
            };
            const script = document.createElement('script');
            script.async = true;
            script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
            document.head.appendChild(script);
            window.gtag('js', new Date());
            window.gtag('config', measurementId, { anonymize_ip: true });
        }
        return measurementId;
    }

    const ga4Id = loadGa4IfNeeded();

    function trackEvent(eventName, params) {
        const payload = params || {};
        if (typeof window.gtag === 'function') {
            window.gtag('event', eventName, payload);
        }
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({
            event: eventName,
            ...payload
        });
    }

    function patchMetaForSeo() {
        const absoluteUrl = `${window.location.origin}/platform`;
        const canonical = document.querySelector('link[rel="canonical"]');
        if (canonical) canonical.setAttribute('href', absoluteUrl);
        const ogUrl = document.querySelector('meta[property="og:url"]');
        if (ogUrl) ogUrl.setAttribute('content', absoluteUrl);
    }

    patchMetaForSeo();

    function resolveHeroVariant() {
        const fromQuery = String(new URLSearchParams(window.location.search).get('ab') || '').trim().toUpperCase();
        if (fromQuery === 'A' || fromQuery === 'B') {
            localStorage.setItem(HERO_VARIANT_KEY, fromQuery);
            return fromQuery;
        }
        const cached = String(localStorage.getItem(HERO_VARIANT_KEY) || '').trim().toUpperCase();
        if (cached === 'A' || cached === 'B') return cached;
        const picked = Math.random() < 0.5 ? 'A' : 'B';
        localStorage.setItem(HERO_VARIANT_KEY, picked);
        return picked;
    }

    function applyHeroVariant(variant) {
        const titleEl = document.querySelector('.hero h1');
        const leadEl = document.querySelector('.hero .lead');
        if (!titleEl || !leadEl) return;
        if (variant === 'B') {
            titleEl.innerHTML = '多租戶旅宿系統快速上線，<br>從接單到報表一次完成';
            leadEl.textContent = '免自建平台、免分散工具，讓你用同一套系統管理多品牌與多館別營運。';
        } else {
            titleEl.innerHTML = '3 分鐘啟用自己的訂房官網，<br>多租戶後台一站管理';
            leadEl.textContent = '從官網接單、付款通知、房型/包棟管理到營運報表，全部整合在同一套系統。';
        }
    }

    const heroVariant = resolveHeroVariant();
    applyHeroVariant(heroVariant);

    trackEvent('page_view', {
        page_type: 'platform_sales',
        page_path: '/platform',
        ga4_id_configured: ga4Id ? 'yes' : 'no',
        hero_variant: heroVariant
    });
    trackEvent('experiment_impression', {
        experiment_name: 'platform_hero_copy',
        variant: heroVariant
    });

    document.querySelectorAll('.js-track-cta').forEach((el) => {
        el.addEventListener('click', () => {
            trackEvent('cta_click', {
                page_type: 'platform_sales',
                cta_name: String(el.getAttribute('data-cta') || 'unknown')
            });
        });
    });

    function setMessage(text, type) {
        formMessage.className = 'form-message';
        if (type) formMessage.classList.add(type);
        formMessage.textContent = text || '';
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        setMessage('送出中，請稍候...', '');
        trackEvent('generate_lead_attempt', {
            page_type: 'platform_sales',
            source: 'platform_cta_form'
        });

        const fd = new FormData(form);
        const payload = {
            tenantName: String(fd.get('tenantName') || '').trim(),
            tenantCode: String(fd.get('tenantCode') || '').trim(),
            adminUsername: String(fd.get('adminUsername') || '').trim(),
            adminEmail: String(fd.get('adminEmail') || '').trim(),
            adminPassword: String(fd.get('adminPassword') || ''),
            planCode: String(fd.get('planCode') || 'basic_monthly').trim()
        };

        try {
            const res = await fetch('/api/public/register-tenant', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await res.json().catch(() => ({}));
            if (!res.ok || !result.success) {
                const msg = String(result.message || '送出失敗，請稍後再試。');
                setMessage(msg, 'error');
                trackEvent('generate_lead_error', {
                    page_type: 'platform_sales',
                    source: 'platform_cta_form',
                    status: String(res.status || ''),
                    message: msg.slice(0, 120)
                });
                return;
            }
            setMessage('申請成功！系統已寄出驗證信，請到信箱完成啟用。', 'success');
            trackEvent('generate_lead', {
                page_type: 'platform_sales',
                source: 'platform_cta_form',
                plan_code: payload.planCode || 'basic_monthly',
                hero_variant: heroVariant
            });
            form.reset();
            const thanksUrl = `/platform/thanks?plan=${encodeURIComponent(payload.planCode || 'basic_monthly')}&variant=${encodeURIComponent(heroVariant)}`;
            window.location.assign(thanksUrl);
        } catch (error) {
            setMessage('網路連線異常，請稍後再試。', 'error');
            trackEvent('generate_lead_error', {
                page_type: 'platform_sales',
                source: 'platform_cta_form',
                status: 'network_error'
            });
        }
    });
})();
