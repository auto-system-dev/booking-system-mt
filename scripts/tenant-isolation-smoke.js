/* eslint-disable no-console */
require('dotenv').config();

const db = require('../database');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function makeBookingPayload(bookingId, tenantId, roomType) {
    const today = new Date();
    const checkIn = new Date(today);
    checkIn.setDate(checkIn.getDate() + 10);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + 1);
    const ymd = (d) => d.toISOString().slice(0, 10);

    return {
        bookingId,
        checkInDate: ymd(checkIn),
        checkOutDate: ymd(checkOut),
        roomType,
        buildingId: 1,
        roomSelections: null,
        guestName: `Tenant ${tenantId} Guest`,
        guestPhone: '0900000000',
        guestEmail: `tenant${tenantId}@example.com`,
        specialRequest: '',
        adults: 2,
        children: 0,
        paymentAmount: '全額',
        paymentMethod: 'transfer',
        pricePerNight: 1000,
        nights: 1,
        totalAmount: 1000,
        finalAmount: 1000,
        bookingDate: new Date().toISOString(),
        emailSent: '0',
        paymentStatus: 'pending',
        status: 'active',
        bookingMode: 'retail',
        addons: null,
        addonsTotal: 0,
        tenantId
    };
}

async function main() {
    const tenantA = 9101;
    const tenantB = 9202;
    const runTag = Date.now().toString();

    const bookingAId = `SMOKE-A-${runTag}`;
    const bookingBId = `SMOKE-B-${runTag}`;
    const roomTypeAName = `smoke_a_${runTag}`;
    const roomTypeBName = `smoke_b_${runTag}`;

    let roomTypeAId = null;
    let roomTypeBId = null;

    try {
        await db.initDatabase();

        // bookings: 分別建立兩個租戶資料
        await db.saveBooking(makeBookingPayload(bookingAId, tenantA, 'SMOKE_ROOM_A'));
        await db.saveBooking(makeBookingPayload(bookingBId, tenantB, 'SMOKE_ROOM_B'));

        const bookingsA = await db.getAllBookings(undefined, undefined, tenantA);
        const bookingsB = await db.getAllBookings(undefined, undefined, tenantB);

        assert(bookingsA.some((b) => b.booking_id === bookingAId), 'Tenant A 看不到自己的 booking');
        assert(!bookingsA.some((b) => b.booking_id === bookingBId), 'Tenant A 看到了 Tenant B 的 booking');
        assert(bookingsB.some((b) => b.booking_id === bookingBId), 'Tenant B 看不到自己的 booking');
        assert(!bookingsB.some((b) => b.booking_id === bookingAId), 'Tenant B 看到了 Tenant A 的 booking');

        // room_types: 分別建立兩個租戶資料
        roomTypeAId = await db.createRoomType({
            building_id: 1,
            name: roomTypeAName,
            display_name: `Smoke Room A ${runTag}`,
            price: 1200,
            original_price: 1200,
            holiday_surcharge: 0,
            is_active: 1,
            display_order: 0,
            list_scope: 'retail'
        }, tenantA);

        roomTypeBId = await db.createRoomType({
            building_id: 1,
            name: roomTypeBName,
            display_name: `Smoke Room B ${runTag}`,
            price: 1300,
            original_price: 1300,
            holiday_surcharge: 0,
            is_active: 1,
            display_order: 0,
            list_scope: 'retail'
        }, tenantB);

        const roomTypesA = await db.getAllRoomTypesAdmin(undefined, undefined, tenantA);
        const roomTypesB = await db.getAllRoomTypesAdmin(undefined, undefined, tenantB);

        assert(roomTypesA.some((r) => r.id === roomTypeAId), 'Tenant A 看不到自己的 room type');
        assert(!roomTypesA.some((r) => r.id === roomTypeBId), 'Tenant A 看到了 Tenant B 的 room type');
        assert(roomTypesB.some((r) => r.id === roomTypeBId), 'Tenant B 看不到自己的 room type');
        assert(!roomTypesB.some((r) => r.id === roomTypeAId), 'Tenant B 看到了 Tenant A 的 room type');

        console.log('✅ Tenant isolation smoke test passed');
        console.log(`   tenantA=${tenantA}, tenantB=${tenantB}, runTag=${runTag}`);
    } finally {
        // 清理測試資料（不影響其他資料）
        try { await db.deleteBooking(bookingAId, tenantA); } catch (_) {}
        try { await db.deleteBooking(bookingBId, tenantB); } catch (_) {}
        try { if (roomTypeAId) await db.deleteRoomType(roomTypeAId, tenantA); } catch (_) {}
        try { if (roomTypeBId) await db.deleteRoomType(roomTypeBId, tenantB); } catch (_) {}
    }
}

main().catch((error) => {
    console.error('❌ Tenant isolation smoke test failed:', error.message);
    process.exitCode = 1;
});

