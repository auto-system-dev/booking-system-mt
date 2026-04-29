function createNotificationService(deps) {
    const {
        db,
        lineBot,
        emailService,
        templateService,
        processEnv,
        replaceTemplateVariables,
        generatePaymentReceivedEmail,
        generateCancellationEmail
    } = deps;
    const resolveTenantId = (data = {}) => data.tenant_id || data.tenantId || processEnv.DEFAULT_TENANT_ID || 1;
    const resolveAdminNotificationEmail = async (tenantIdLike) => {
        const tenantId = resolveTenantId({ tenantId: tenantIdLike });
        const configured = String((await db.getSetting('admin_email', tenantId)) || '').trim();
        const fallback = String(processEnv.ADMIN_EMAIL || 'cheng701107@gmail.com').trim();
        return configured || fallback;
    };

    async function buildMailOptionsFromTemplateWithFallback(params) {
        const {
            context,
            to,
            templateKey,
            templateArgs = [],
            fallbackSubject,
            fallbackHtmlFactory
        } = params;
        const emailUser = await emailService.getRequiredEmailUser(context);

        try {
            const { subject, content } = await templateService.generateEmailFromTemplate(templateKey, ...templateArgs);
            return {
                mailOptions: {
                    from: emailUser,
                    to,
                    subject,
                    html: content
                },
                usedFallback: false
            };
        } catch (templateError) {
            console.error(`⚠️ 無法從數據庫讀取 ${templateKey} 模板，使用備用方案:`, templateError.message);
            const fallbackHtml = await fallbackHtmlFactory();
            return {
                mailOptions: {
                    from: emailUser,
                    to,
                    subject: fallbackSubject,
                    html: fallbackHtml
                },
                usedFallback: true
            };
        }
    }

    async function sendOrderQueryOtpEmail(email, code) {
        const emailUser = await emailService.getRequiredEmailUser('訂單查詢 OTP');
        await emailService.sendEmail({
            from: emailUser,
            to: email,
            subject: '【訂單查詢】一次性驗證碼',
            html: `
                <div style="font-family: 'Noto Sans TC', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <h2 style="color: #262A33;">訂單查詢驗證碼</h2>
                    <p>您好，您正在進行訂單查詢，請使用以下驗證碼完成驗證：</p>
                    <div style="background: #f5f7fb; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px;">
                        <h1 style="color: #2C8EC4; font-size: 32px; margin: 0; letter-spacing: 5px;">${code}</h1>
                    </div>
                    <p style="color: #666; font-size: 14px;">此驗證碼有效期限為 15 分鐘，且僅可使用一次。</p>
                    <p style="color: #666; font-size: 14px;">若非本人操作，請忽略此郵件。</p>
                </div>
            `
        });
    }

    async function sendCardPaymentSuccessNotifications(booking) {
        let addonsList = '';
        if (booking.addons) {
            try {
                const parsedAddons = typeof booking.addons === 'string' ? JSON.parse(booking.addons) : booking.addons;
                if (parsedAddons && parsedAddons.length > 0) {
                    const allAddons = await db.getAllAddonsAdmin(resolveTenantId(booking));
                    addonsList = parsedAddons.map(addon => {
                        const addonInfo = allAddons.find(a => a.name === addon.name);
                        const rawDisplayName = String(
                            addon.display_name ||
                            addon.displayName ||
                            (addonInfo ? addonInfo.display_name : '') ||
                            ''
                        ).trim();
                        const normalizedAddonName = String(addon.name || '').trim();
                        const displayName = rawDisplayName || (
                            /(?:room[_-]?extra[_-]?bed|extra[_-]?bed)/i.test(normalizedAddonName)
                                ? '加床'
                                : (normalizedAddonName || '加購項目')
                        );
                        const quantity = addon.quantity || 1;
                        const itemTotal = addon.price * quantity;
                        const unitLabel = String(addon.unit_label || addon.unitLabel || addonInfo?.unit_label || '人').trim();
                        return `${displayName} x${quantity} (每${unitLabel}, NT$ ${itemTotal.toLocaleString()})`;
                    }).join('、');
                }
            } catch (err) {
                console.error('處理加購商品顯示失敗:', err);
            }
        }

        const originalAmount = booking.original_amount || booking.originalAmount || booking.total_amount || booking.totalAmount || 0;
        const discountAmount = booking.discount_amount || booking.discountAmount || 0;
        const discountedTotal = booking.discountedTotal || (discountAmount > 0 ? Math.max(0, originalAmount - discountAmount) : originalAmount);

        let roomTypeForEmail = String(booking.room_type || '').trim();
        try {
            roomTypeForEmail = await db.resolveRoomTypeDisplayNameForEmail(
                resolveTenantId(booking),
                roomTypeForEmail,
                booking.building_id ?? booking.buildingId
            );
        } catch (_) {
            /* 保持原字串 */
        }

        const bookingData = {
            bookingId: booking.booking_id,
            tenantId: resolveTenantId(booking),
            guestName: booking.guest_name,
            guestEmail: booking.guest_email,
            guestPhone: booking.guest_phone,
            specialRequest: booking.special_request || '',
            checkInDate: booking.check_in_date,
            checkOutDate: booking.check_out_date,
            roomType: roomTypeForEmail,
            pricePerNight: booking.price_per_night,
            nights: booking.nights,
            originalAmount: originalAmount,
            totalAmount: originalAmount,
            discountAmount: discountAmount,
            discountedTotal: discountedTotal,
            finalAmount: booking.final_amount,
            paymentAmount: booking.payment_amount,
            paymentMethod: booking.payment_method,
            paymentMethodCode: 'card',
            paymentStatus: 'paid',
            bookingDate: booking.booking_date,
            bankInfo: null,
            addons: booking.addons ? (typeof booking.addons === 'string' ? JSON.parse(booking.addons) : booking.addons) : null,
            addonsTotal: booking.addons_total || 0,
            addonsList: addonsList
        };

        const emailUser = await emailService.getRequiredEmailUser('綠界回傳寄送訂房確認');

        let customerMailOptions = null;
        try {
            const { subject, content } = await templateService.generateEmailFromTemplate('booking_confirmation', bookingData);
            customerMailOptions = {
                from: emailUser,
                to: booking.guest_email,
                subject: subject,
                html: content
            };
        } catch (templateError) {
            console.error('⚠️ 無法從數據庫讀取訂房確認模板，使用備用方案:', templateError.message);
            customerMailOptions = {
                from: emailUser,
                to: booking.guest_email,
                subject: '【訂房確認】您的訂房已成功',
                html: await templateService.generateCustomerEmail(bookingData)
            };
        }

        let emailSent = false;
        try {
            await emailService.sendEmail(customerMailOptions);
            console.log('✅ 確認郵件已發送');
            emailSent = true;
        } catch (emailError) {
            console.error('❌ 確認郵件發送失敗:', emailError.message);
        }

        if (emailSent) {
            await db.updateEmailStatus(booking.booking_id, 'booking_confirmation', false, resolveTenantId(booking));
            console.log('✅ 郵件狀態已更新');
        }

        try {
            const adminEmail = await resolveAdminNotificationEmail(resolveTenantId(booking));
            let adminMailOptions = null;
            try {
                const { subject, content } = await templateService.generateEmailFromTemplate('booking_confirmation_admin', bookingData);
                adminMailOptions = {
                    from: emailUser,
                    to: adminEmail,
                    subject: subject,
                    html: content
                };
            } catch (adminTemplateError) {
                console.error('⚠️ 無法從數據庫讀取管理員通知模板，使用備用方案:', adminTemplateError.message);
                adminMailOptions = {
                    from: emailUser,
                    to: adminEmail,
                    subject: `【新訂房通知】${booking.guest_name} - ${booking.booking_id}`,
                    html: templateService.generateAdminEmail(bookingData)
                };
            }
            await emailService.sendEmail(adminMailOptions);
        } catch (adminEmailError) {
            console.error('❌ 管理者通知郵件發送失敗:', adminEmailError.message);
        }

        if (booking.line_user_id) {
            try {
                await lineBot.loadSettings();
                const lineResult = await lineBot.sendBookingSuccessMessage(booking.line_user_id, {
                    bookingId: booking.booking_id,
                    guestName: booking.guest_name,
                    checkInDate: booking.check_in_date,
                    checkOutDate: booking.check_out_date,
                    roomType: roomTypeForEmail,
                    totalAmount: originalAmount,
                    discountAmount: discountAmount,
                    discountedTotal: discountedTotal,
                    finalAmount: booking.final_amount,
                    isPaid: true
                });
                if (!lineResult.success) {
                    console.warn('⚠️ LINE 訊息發送失敗:', lineResult.error);
                }
            } catch (lineError) {
                console.error('❌ LINE 訊息發送錯誤:', lineError.message);
            }
        }
    }

    async function sendTransferBookingCreatedNotifications(params) {
        const {
            bookingData,
            guestEmail,
            guestName,
            bankInfo
        } = params;

        const customerRender = await buildMailOptionsFromTemplateWithFallback({
            context: '建立訂房寄信',
            to: guestEmail,
            templateKey: 'booking_confirmation',
            templateArgs: [bookingData, bankInfo],
            fallbackSubject: '【訂房確認】您的訂房已成功',
            fallbackHtmlFactory: () => templateService.generateCustomerEmail(bookingData)
        });

        const adminEmail = await resolveAdminNotificationEmail(resolveTenantId(bookingData));
        const adminRender = await buildMailOptionsFromTemplateWithFallback({
            context: '建立訂房寄信',
            to: adminEmail,
            templateKey: 'booking_confirmation_admin',
            templateArgs: [bookingData],
            fallbackSubject: `【新訂房通知】${guestName} - ${bookingData.bookingId}`,
            fallbackHtmlFactory: async () => templateService.generateAdminEmail(bookingData)
        });

        let customerEmailSent = false;
        let customerEmailError = '';
        try {
            await emailService.sendEmail(customerRender.mailOptions);
            customerEmailSent = true;
            console.log('✅ 客戶確認郵件已發送');
        } catch (emailError) {
            customerEmailError = emailError.message || '未知錯誤';
            console.error('❌ 客戶郵件發送失敗:', customerEmailError);
        }

        let adminEmailSent = false;
        try {
            await emailService.sendEmail(adminRender.mailOptions);
            adminEmailSent = true;
            console.log('✅ 管理員通知郵件已發送');
        } catch (adminEmailError) {
            console.error('❌ 管理員通知郵件發送失敗:', adminEmailError.message);
        }

        return {
            customerEmailSent,
            customerEmailError,
            adminEmailSent
        };
    }

    async function sendPaymentCompletedEmail(booking) {
        const renderResult = await buildMailOptionsFromTemplateWithFallback({
            context: '手動更新付款狀態寄信',
            to: booking.guest_email,
            templateKey: 'payment_completed',
            templateArgs: [booking],
            fallbackSubject: '【收款確認】我們已收到您的款項',
            fallbackHtmlFactory: () => generatePaymentReceivedEmail(booking)
        });

        try {
            await emailService.sendEmail(renderResult.mailOptions);
            await db.updateEmailStatus(booking.booking_id, 'payment_received', true, resolveTenantId(booking));
            return true;
        } catch (emailError) {
            console.error(`❌ 收款信發送失敗 (${booking.booking_id}):`, emailError.message);
            return false;
        }
    }

    async function sendPaymentReminderEmail(params) {
        const { booking, bankInfo, template } = params;

        const renderResult = await buildMailOptionsFromTemplateWithFallback({
            context: '匯款提醒排程',
            to: booking.guest_email,
            templateKey: 'payment_reminder',
            templateArgs: [booking, bankInfo],
            fallbackSubject: template && template.subject ? template.subject : '【重要提醒】匯款期限即將到期',
            fallbackHtmlFactory: async () => {
                const fallback = await replaceTemplateVariables(template, booking, bankInfo);
                return fallback.content;
            }
        });

        try {
            await emailService.sendEmail(renderResult.mailOptions);
            await db.updateEmailStatus(booking.booking_id, 'payment_reminder', true, resolveTenantId(booking));
            return true;
        } catch (emailError) {
            console.error(`❌ 發送匯款提醒失敗 (${booking.booking_id}):`, emailError.message);
            return false;
        }
    }

    async function sendCancelNotificationEmail(booking) {
        const renderResult = await buildMailOptionsFromTemplateWithFallback({
            context: '自動取消通知',
            to: booking.guest_email,
            templateKey: 'cancel_notification',
            templateArgs: [booking],
            fallbackSubject: '【訂房取消通知】您的訂房已自動取消',
            fallbackHtmlFactory: () => generateCancellationEmail(booking)
        });

        try {
            await emailService.sendEmail(renderResult.mailOptions);
            await db.updateEmailStatus(booking.booking_id, 'cancel_notification', true, resolveTenantId(booking));
            return true;
        } catch (emailError) {
            console.error(`❌ 發送取消通知失敗 (${booking.booking_id}):`, emailError.message);
            return false;
        }
    }

    async function sendCheckinReminderEmail(params) {
        const { booking, template, additionalData } = params;

        const renderResult = await buildMailOptionsFromTemplateWithFallback({
            context: '入住提醒排程',
            to: booking.guest_email,
            templateKey: 'checkin_reminder',
            templateArgs: [booking, null, additionalData],
            fallbackSubject: template && template.subject ? template.subject : '【入住提醒】歡迎您明天入住',
            fallbackHtmlFactory: async () => {
                const fallback = await replaceTemplateVariables(template, booking, null, additionalData);
                return fallback.content;
            }
        });

        if (!renderResult.mailOptions.html || renderResult.mailOptions.html.trim() === '') {
            console.error(`❌ 生成的郵件內容為空，跳過發送 (${booking.booking_id})`);
            return false;
        }

        try {
            await emailService.sendEmail(renderResult.mailOptions);
            await db.updateEmailStatus(booking.booking_id, 'checkin_reminder', true, resolveTenantId(booking));
            return true;
        } catch (emailError) {
            console.error(`❌ 發送入住提醒失敗 (${booking.booking_id}):`, emailError.message);
            return false;
        }
    }

    async function sendFeedbackRequestEmail(params) {
        const { booking, template, additionalData } = params;

        const renderResult = await buildMailOptionsFromTemplateWithFallback({
            context: '回訪信排程',
            to: booking.guest_email,
            templateKey: 'feedback_request',
            templateArgs: [booking, null, additionalData],
            fallbackSubject: template && template.subject ? template.subject : '【感謝入住】分享您的住宿體驗',
            fallbackHtmlFactory: async () => {
                const fallback = await replaceTemplateVariables(template, booking, null, additionalData);
                return fallback.content;
            }
        });

        try {
            await emailService.sendEmail(renderResult.mailOptions);
            await db.updateEmailStatus(booking.booking_id, 'feedback_request', true, resolveTenantId(booking));
            return true;
        } catch (emailError) {
            console.error(`❌ 發送回訪信失敗 (${booking.booking_id}):`, emailError.message);
            return false;
        }
    }

    function formatDateTimeForMail(value) {
        if (!value) return '待確認';
        const dt = new Date(value);
        if (Number.isNaN(dt.getTime())) return '待確認';
        try {
            return new Intl.DateTimeFormat('zh-TW', {
                timeZone: 'Asia/Taipei',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }).format(dt);
        } catch (_) {
            return dt.toISOString();
        }
    }

    function resolvePlanLabel(planCode) {
        const code = String(planCode || '').trim().toLowerCase();
        const labels = {
            basic_monthly: '基礎方案（月繳）',
            basic_yearly: '基礎方案（年繳）',
            pro_monthly: '專業方案（月繳）',
            pro_yearly: '專業方案（年繳）'
        };
        return labels[code] || code || '訂閱方案';
    }

    async function sendSubscriptionActivatedNotification(params = {}) {
        const tenantId = resolveTenantId({ tenantId: params.tenantId });
        const snapshot = params.snapshot || {};
        const adminEmail = await resolveAdminNotificationEmail(tenantId);
        if (!adminEmail) return false;
        let tenantName = `租戶 #${tenantId}`;
        if (typeof db.getTenantById === 'function') {
            try {
                const tenant = await db.getTenantById(tenantId);
                if (tenant?.name) tenantName = String(tenant.name);
            } catch (_) {
                // ignore
            }
        }
        const planLabel = resolvePlanLabel(snapshot.planCode || snapshot.plan_code);
        const nextBillingText = formatDateTimeForMail(snapshot.nextBillingAt || snapshot.next_billing_at);
        const templateData = {
            tenantId,
            tenantName,
            planCode: String(snapshot.planCode || snapshot.plan_code || ''),
            planName: planLabel,
            billingCycle: String(snapshot.billingCycle || snapshot.billing_cycle || ''),
            nextBillingAt: nextBillingText,
            status: '啟用中'
        };
        const renderResult = await buildMailOptionsFromTemplateWithFallback({
            context: '訂閱啟用通知',
            to: adminEmail,
            templateKey: 'subscription_activated_notification',
            templateArgs: [templateData],
            fallbackSubject: `【訂閱啟用成功】${tenantName} 已啟用 ${planLabel}`,
            fallbackHtmlFactory: async () => `
                <div style="font-family: 'Noto Sans TC', Arial, sans-serif; max-width: 680px; margin: 0 auto; color: #1f2937; line-height: 1.8;">
                    <h2 style="margin: 0 0 12px;">訂閱啟用成功</h2>
                    <p>您好，${tenantName} 已完成訂閱授權並啟用成功。</p>
                    <div style="background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 14px; margin: 14px 0;">
                        <div><strong>租戶：</strong>${tenantName}</div>
                        <div><strong>方案：</strong>${planLabel}</div>
                        <div><strong>下次扣款：</strong>${nextBillingText}</div>
                        <div><strong>狀態：</strong>啟用中</div>
                    </div>
                    <p style="color: #6b7280; font-size: 13px;">此為系統自動通知信，您可至後台「系統設定 → 訂閱狀態」查看完整資訊。</p>
                </div>
            `
        });

        try {
            await emailService.sendEmail(renderResult.mailOptions);
            return true;
        } catch (error) {
            console.error(`❌ 訂閱成功通知郵件發送失敗 (tenant=${tenantId}):`, error.message);
            return false;
        }
    }

    return {
        sendOrderQueryOtpEmail,
        sendCardPaymentSuccessNotifications,
        sendTransferBookingCreatedNotifications,
        sendPaymentCompletedEmail,
        sendPaymentReminderEmail,
        sendCancelNotificationEmail,
        sendCheckinReminderEmail,
        sendFeedbackRequestEmail,
        sendSubscriptionActivatedNotification
    };
}

module.exports = {
    createNotificationService
};
