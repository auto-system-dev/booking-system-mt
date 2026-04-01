function createHotelConfigService(deps) {
    const {
        db
    } = deps;
    const defaultTenantId = parseInt(process.env.DEFAULT_TENANT_ID || '1', 10);

    const DEFAULT_HOTEL_SETTINGS = {
        name: 'XX旅宿',
        phone: '02-1234-5678',
        address: '台北市信義區信義路五段7號',
        email: 'service@hotel.com'
    };

    async function getHotelSettingsWithFallback() {
        const hotelName = ((await db.getSetting('hotel_name', defaultTenantId)) || '').trim() || DEFAULT_HOTEL_SETTINGS.name;
        const hotelPhone = ((await db.getSetting('hotel_phone', defaultTenantId)) || '').trim() || DEFAULT_HOTEL_SETTINGS.phone;
        const hotelAddress = ((await db.getSetting('hotel_address', defaultTenantId)) || '').trim() || DEFAULT_HOTEL_SETTINGS.address;
        const hotelEmail = ((await db.getSetting('hotel_email', defaultTenantId)) || '').trim() || DEFAULT_HOTEL_SETTINGS.email;
        return { hotelName, hotelPhone, hotelAddress, hotelEmail };
    }

    return {
        getHotelSettingsWithFallback
    };
}

module.exports = {
    createHotelConfigService
};
