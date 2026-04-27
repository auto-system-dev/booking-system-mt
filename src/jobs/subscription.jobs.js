function createSubscriptionJobs(deps) {
    const { db, paymentService } = deps;
    const getPaymentService = () => (typeof paymentService === 'function' ? paymentService() : paymentService);

    async function runDailySubscriptionCheck() {
        try {
            const result = await db.runSubscriptionDailyCheck();
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

