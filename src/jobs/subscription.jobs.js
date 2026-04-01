function createSubscriptionJobs(deps) {
    const { db } = deps;

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

    return {
        runDailySubscriptionCheck
    };
}

module.exports = {
    createSubscriptionJobs
};

