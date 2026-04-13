(function () {
    const form = document.getElementById('tenantSignupForm');
    const formMessage = document.getElementById('formMessage');
    if (!form || !formMessage) return;

    function setMessage(text, type) {
        formMessage.className = 'form-message';
        if (type) formMessage.classList.add(type);
        formMessage.textContent = text || '';
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        setMessage('送出中，請稍候...', '');

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
                return;
            }
            setMessage('申請成功！系統已寄出驗證信，請到信箱完成啟用。', 'success');
            form.reset();
        } catch (error) {
            setMessage('網路連線異常，請稍後再試。', 'error');
        }
    });
})();
