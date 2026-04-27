const express = require('express');
const multer = require('multer');

function createPaymentRoutes(deps) {
    const {
        controller,
        paymentLimiter
    } = deps;

    const router = express.Router();
    const parseMultipartFields = multer().none();

    router.post('/create', paymentLimiter, controller.createPayment);
    router.post('/return', paymentLimiter, controller.paymentReturn);
    router.get('/result', paymentLimiter, controller.paymentResult);
    router.post('/result', paymentLimiter, controller.paymentResult);
    router.post('/newebpay/subscription/webhook', parseMultipartFields, controller.newebpaySubscriptionWebhook);
    router.post('/newebpay/subscription/create', paymentLimiter, controller.newebpayCreateSubscription);
    router.post('/newebpay/subscription/alter-status', paymentLimiter, controller.newebpayAlterSubscriptionStatus);
    router.post('/newebpay/subscription/alter-content', paymentLimiter, controller.newebpayAlterSubscriptionContent);

    return router;
}

module.exports = {
    createPaymentRoutes
};
