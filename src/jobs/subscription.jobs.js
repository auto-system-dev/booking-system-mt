function createSubscriptionJobs(deps) {
    const { db, paymentService, notificationService } = deps;
    const getPaymentService = () => (typeof paymentService === 'function' ? paymentService() : paymentService);
    const toDate = (value) => {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    };
    const daysDiffFromNow = (value) => {
        const d = toDate(value);
        if (!d) return null;
        const now = new Date();
        const ms = d.getTime() - now.getTime();
        return Math.ceil(ms / (24 * 60 * 60 * 1000));
    };
    const toDateText = (value) => {
        const d = toDate(value);
        if (!d) return '待確認';
        try {
            return new Intl.DateTimeFormat('zh-TW', {
                timeZone: 'Asia/Taipei',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }).format(d);
        } catch (_) {
            return d.toISOString().slice(0, 10);
        }
    };
    const getSetting = async (tenantId, key) => {
        try {
            return String((await db.getSetting(key, tenantId)) || '').trim();
        } catch (_) {
            return '';
        }
    };
    const markSent = async (tenantId, key, value) => {
        if (typeof db.updateSetting !== 'function') return;
        try {
            await db.updateSetting(key, value, 'subscription notification marker', tenantId);
        } catch (_) {
            // ignore marker failures
        }
    };
    async function runLifecycleNotifications() {
        if (!notificationService) return;
        const overview = await db.getTenantsOverview({ limit: 2000, offset: 0 });
        const tenantList = Array.isArray(overview?.items) ? overview.items : [];
        for (const tenant of tenantList) {
            const tenantId = parseInt(tenant?.id, 10);
            if (!Number.isInteger(tenantId) || tenantId <= 0) continue;
            const snapshot = await db.getTenantSubscriptionSnapshot(tenantId);
            const periodEnd = snapshot?.periodEnd || snapshot?.recurring?.nextBillingAt || null;
            const daysLeft = daysDiffFromNow(periodEnd);
            const dateText = toDateText(periodEnd);
            const tenantName = String(tenant?.name || `租戶 #${tenantId}`);
            const markerDate = new Date().toISOString().slice(0, 10);
            const status = String(snapshot?.status || '').toLowerCase();
            const failedCount = parseInt(snapshot?.recurring?.failedPaymentCount || 0, 10) || 0;

            if (status === 'trialing' && daysLeft != null && [7, 3, 1].includes(daysLeft)) {
                const markerKey = `notif_trial_expiring_${daysLeft}`;
                if ((await getSetting(tenantId, markerKey)) !== markerDate) {
                    await notificationService.sendTrialExpiringNotification({
                        tenantId,
                        tenantName,
                        planCode: snapshot?.planCode || '',
                        expireDate: dateText,
                        daysLeft,
                        status: snapshot?.status || 'trialing'
                    });
                    await markSent(tenantId, markerKey, markerDate);
                }
            }

            if (status === 'past_due' && failedCount === 0 && daysLeft != null && daysLeft <= 0) {
                const markerKey = 'notif_trial_expired';
                if ((await getSetting(tenantId, markerKey)) !== markerDate) {
                    await notificationService.sendTrialExpiredNotification({
                        tenantId,
                        tenantName,
                        planCode: snapshot?.planCode || '',
                        expireDate: dateText,
                        status: snapshot?.status || 'past_due'
                    });
                    await markSent(tenantId, markerKey, markerDate);
                }
            }

            if (status === 'active' && daysLeft != null && [7, 3, 1].includes(daysLeft)) {
                const markerKey = `notif_subscription_expiring_${daysLeft}`;
                if ((await getSetting(tenantId, markerKey)) !== markerDate) {
                    await notificationService.sendSubscriptionExpiringNotification({
                        tenantId,
                        tenantName,
                        planCode: snapshot?.planCode || '',
                        expireDate: dateText,
                        daysLeft,
                        status: snapshot?.status || 'active'
                    });
                    await markSent(tenantId, markerKey, markerDate);
                }
            }
        }
    }

    async function runDailySubscriptionCheck() {
        try {
            const result = await db.runSubscriptionDailyCheck();
            await runLifecycleNotifications();
            console.log(
                `✅ 訂閱日檢完成（past_due: ${result.toPastDue}, canceled: ${result.toCanceled}, checked: ${result.checked})`
            );
        } catch (error) {
            console.error('❌ 訂閱日檢失敗:', error.message);
        }
    }

    async function runNewebpayReconcileJob() {
        try {
            const service = getPaymentService();
            if (!service || typeof service.reconcileRecentNewebpayEvents !== 'function') {
                return;
            }
            const result = await service.reconcileRecentNewebpayEvents({ hours: 48, limit: 500 });
            console.log(`✅ 藍新訂閱補償完成（scanned: ${result.scanned}, synced: ${result.synced}, errors: ${result.errors})`);
        } catch (error) {
            console.error('❌ 藍新訂閱補償失敗:', error.message);
        }
    }

    return {
        runDailySubscriptionCheck,
        runNewebpayReconcileJob
    };
}

module.exports = {
    createSubscriptionJobs
};

