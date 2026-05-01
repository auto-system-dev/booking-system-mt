/**
 * 資料庫備份模組
 * 支援 SQLite 和 PostgreSQL 的自動備份功能
 * PostgreSQL 使用 JavaScript 原生 SQL 查詢匯出（不依賴 pg_dump）
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// 備份目錄（支援環境變數設定，適用於 Railway Volume 掛載）
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const BACKUP_UPLOAD_TO_R2 = String(process.env.BACKUP_UPLOAD_TO_R2 || 'false').trim().toLowerCase() === 'true';
const R2_ACCOUNT_ID = String(process.env.R2_ACCOUNT_ID || '').trim();
const R2_ACCESS_KEY_ID = String(process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_BUCKET_NAME = String(process.env.R2_BUCKET_NAME || '').trim();
const R2_BACKUP_PREFIX = String(process.env.R2_BACKUP_PREFIX || 'db-backups').trim().replace(/^\/+|\/+$/g, '');

let r2Client = null;

function canUploadBackupToR2() {
    if (!BACKUP_UPLOAD_TO_R2) return false;
    return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME);
}

function getR2Client() {
    if (!canUploadBackupToR2()) return null;
    if (r2Client) return r2Client;
    r2Client = new S3Client({
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY
        }
    });
    return r2Client;
}

async function uploadBackupFileToR2(localFilePath, tenantId, backupFileName) {
    const client = getR2Client();
    if (!client) {
        return {
            uploaded: false,
            reason: 'R2 自動上傳未啟用或缺少必要環境變數'
        };
    }
    const safeTenantId = assertTenantId(tenantId);
    const safeName = path.basename(String(backupFileName || '').trim());
    if (!safeName) {
        throw new Error('缺少備份檔名，無法上傳 R2');
    }
    if (!fs.existsSync(localFilePath)) {
        throw new Error(`備份檔案不存在，無法上傳 R2：${localFilePath}`);
    }

    const key = `${R2_BACKUP_PREFIX}/${safeTenantId}/${safeName}`;
    const body = fs.readFileSync(localFilePath);
    const contentType = safeName.endsWith('.json') ? 'application/json' : 'application/octet-stream';

    await client.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: contentType,
        Metadata: {
            tenant_id: String(safeTenantId),
            source: 'booking-system-backup'
        }
    }));
    console.log(`☁️ R2 備份上傳成功: s3://${R2_BUCKET_NAME}/${key}`);
    return {
        uploaded: true,
        bucket: R2_BUCKET_NAME,
        key
    };
}

// 確保備份目錄存在
function ensureBackupDir() {
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        console.log('✅ 備份目錄已建立:', BACKUP_DIR);
    }
}

function assertTenantId(tenantId) {
    const n = Number.parseInt(tenantId, 10);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error('缺少 tenant_id，無法進行備份操作');
    }
    return n;
}

function getTenantBackupDir(tenantId) {
    ensureBackupDir();
    const tid = assertTenantId(tenantId);
    const dir = path.join(BACKUP_DIR, String(tid));
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function getSystemBackupDir() {
    ensureBackupDir();
    const dir = path.join(BACKUP_DIR, '_system');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function createTimestampFilePart() {
    return new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0];
}

/**
 * 備份 SQLite 資料庫
 */
async function backupSQLite(dbPath, tenantId) {
    try {
        const tenantDir = getTenantBackupDir(tenantId);
        
        // 檢查資料庫檔案是否存在
        if (!fs.existsSync(dbPath)) {
            throw new Error(`資料庫檔案不存在: ${dbPath}`);
        }
        
        // 產生備份檔名：backup_YYYYMMDD_HHMMSS.db
        const now = new Date();
        const dateStr = createTimestampFilePart();
        const backupFileName = `backup_${dateStr}.db`;
        const backupPath = path.join(tenantDir, backupFileName);
        
        // 複製資料庫檔案
        fs.copyFileSync(dbPath, backupPath);
        
        // 取得檔案大小
        const stats = fs.statSync(backupPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        console.log(`✅ SQLite 備份成功: ${backupFileName} (${fileSizeMB} MB)`);
        
        return {
            success: true,
            fileName: backupFileName,
            filePath: backupPath,
            fileSize: stats.size,
            fileSizeMB: parseFloat(fileSizeMB),
            timestamp: now.toISOString()
        };
    } catch (error) {
        console.error('❌ SQLite 備份失敗:', error.message);
        throw error;
    }
}

/**
 * 備份 PostgreSQL 資料庫（使用 JavaScript 原生 SQL 查詢匯出）
 * 不依賴 pg_dump，適用於 Railway 等無 pg_dump 的環境
 */
async function backupPostgreSQL(databaseUrl, tenantId) {
    try {
        const tenantDir = getTenantBackupDir(tenantId);
        
        // 建立獨立連線池進行備份
        const pool = new Pool({
            connectionString: databaseUrl,
            ssl: databaseUrl.includes('railway') ? { rejectUnauthorized: false } : false
        });
        
        // 產生備份檔名：backup_YYYYMMDD_HHMMSS.json
        const now = new Date();
        const dateStr = createTimestampFilePart();
        const backupFileName = `backup_${dateStr}.json`;
        const backupPath = path.join(tenantDir, backupFileName);
        
        console.log('📦 開始匯出 PostgreSQL 資料...');
        
        // 取得所有使用者建立的資料表
        const tablesResult = await pool.query(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_type = 'BASE TABLE'
            ORDER BY table_name
        `);
        
        const tables = tablesResult.rows.map(r => r.table_name);
        console.log(`📋 找到 ${tables.length} 個資料表: ${tables.join(', ')}`);
        
        const backupData = {
            metadata: {
                version: '1.0',
                type: 'postgresql_json_backup',
                created_at: now.toISOString(),
                tables: tables,
                table_count: tables.length
            },
            data: {}
        };
        
        // 逐一匯出每個資料表的資料
        for (const table of tables) {
            try {
                // 取得資料表結構
                const columnsResult = await pool.query(`
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns 
                    WHERE table_schema = 'public' AND table_name = $1
                    ORDER BY ordinal_position
                `, [table]);
                
                // 取得資料
                const dataResult = await pool.query(`SELECT * FROM "${table}"`);
                
                backupData.data[table] = {
                    columns: columnsResult.rows,
                    row_count: dataResult.rows.length,
                    rows: dataResult.rows
                };
                
                console.log(`  ✅ ${table}: ${dataResult.rows.length} 筆資料`);
            } catch (tableError) {
                console.error(`  ❌ 匯出 ${table} 失敗:`, tableError.message);
                backupData.data[table] = {
                    error: tableError.message,
                    row_count: 0,
                    rows: []
                };
            }
        }
        
        // 更新 metadata 的記錄數
        let totalRows = 0;
        for (const table of tables) {
            totalRows += (backupData.data[table]?.row_count || 0);
        }
        backupData.metadata.total_rows = totalRows;
        
        // 寫入備份檔案
        const jsonStr = JSON.stringify(backupData, null, 2);
        fs.writeFileSync(backupPath, jsonStr, 'utf8');
        
        // 關閉獨立連線池
        await pool.end();
        
        // 取得檔案大小
        const stats = fs.statSync(backupPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        console.log(`✅ PostgreSQL 備份成功: ${backupFileName} (${fileSizeMB} MB, ${totalRows} 筆資料)`);
        
        return {
            success: true,
            fileName: backupFileName,
            filePath: backupPath,
            fileSize: stats.size,
            fileSizeMB: parseFloat(fileSizeMB),
            timestamp: now.toISOString(),
            tableCount: tables.length,
            totalRows: totalRows
        };
    } catch (error) {
        console.error('❌ PostgreSQL 備份失敗:', error.message);
        throw error;
    }
}

async function backupSQLiteSystem(dbPath) {
    try {
        const systemDir = getSystemBackupDir();
        if (!fs.existsSync(dbPath)) {
            throw new Error(`資料庫檔案不存在: ${dbPath}`);
        }
        const now = new Date();
        const dateStr = createTimestampFilePart();
        const backupFileName = `system_backup_${dateStr}.db`;
        const backupPath = path.join(systemDir, backupFileName);
        fs.copyFileSync(dbPath, backupPath);
        const stats = fs.statSync(backupPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        console.log(`✅ SQLite 全系統備份成功: ${backupFileName} (${fileSizeMB} MB)`);
        return {
            success: true,
            fileName: backupFileName,
            filePath: backupPath,
            fileSize: stats.size,
            fileSizeMB: parseFloat(fileSizeMB),
            timestamp: now.toISOString(),
            scope: 'system'
        };
    } catch (error) {
        console.error('❌ SQLite 全系統備份失敗:', error.message);
        throw error;
    }
}

async function backupPostgreSQLSystem(databaseUrl) {
    try {
        const systemDir = getSystemBackupDir();
        const pool = new Pool({
            connectionString: databaseUrl,
            ssl: databaseUrl.includes('railway') ? { rejectUnauthorized: false } : false
        });
        const now = new Date();
        const dateStr = createTimestampFilePart();
        const backupFileName = `system_backup_${dateStr}.json`;
        const backupPath = path.join(systemDir, backupFileName);

        console.log('📦 開始匯出 PostgreSQL 全系統資料...');
        const tablesResult = await pool.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_type = 'BASE TABLE'
            ORDER BY table_name
        `);
        const tables = tablesResult.rows.map(r => r.table_name);
        const backupData = {
            metadata: {
                version: '1.0',
                type: 'postgresql_json_backup',
                scope: 'system',
                created_at: now.toISOString(),
                tables,
                table_count: tables.length
            },
            data: {}
        };
        for (const table of tables) {
            try {
                const columnsResult = await pool.query(`
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = $1
                    ORDER BY ordinal_position
                `, [table]);
                const dataResult = await pool.query(`SELECT * FROM "${table}"`);
                backupData.data[table] = {
                    columns: columnsResult.rows,
                    row_count: dataResult.rows.length,
                    rows: dataResult.rows
                };
            } catch (tableError) {
                console.error(`  ❌ 匯出 ${table} 失敗:`, tableError.message);
                backupData.data[table] = {
                    error: tableError.message,
                    row_count: 0,
                    rows: []
                };
            }
        }
        let totalRows = 0;
        for (const table of tables) {
            totalRows += (backupData.data[table]?.row_count || 0);
        }
        backupData.metadata.total_rows = totalRows;
        fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2), 'utf8');
        await pool.end();
        const stats = fs.statSync(backupPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        console.log(`✅ PostgreSQL 全系統備份成功: ${backupFileName} (${fileSizeMB} MB, ${totalRows} 筆資料)`);
        return {
            success: true,
            fileName: backupFileName,
            filePath: backupPath,
            fileSize: stats.size,
            fileSizeMB: parseFloat(fileSizeMB),
            timestamp: now.toISOString(),
            tableCount: tables.length,
            totalRows,
            scope: 'system'
        };
    } catch (error) {
        console.error('❌ PostgreSQL 全系統備份失敗:', error.message);
        throw error;
    }
}

/**
 * 執行資料庫備份（自動偵測資料庫類型）
 */
async function performBackup(tenantId) {
    try {
        console.log('\n[備份任務] 開始執行資料庫備份...');
        
        const usePostgreSQL = !!process.env.DATABASE_URL;
        
        let result;
        if (usePostgreSQL) {
            // PostgreSQL 備份
            result = await backupPostgreSQL(process.env.DATABASE_URL, tenantId);
        } else {
            // SQLite 備份
            const dbPath = path.join(__dirname, 'bookings.db');
            result = await backupSQLite(dbPath, tenantId);
        }

        try {
            const r2Upload = await uploadBackupFileToR2(result.filePath, tenantId, result.fileName);
            result.r2Upload = r2Upload;
        } catch (uploadError) {
            console.error('⚠️ R2 備份上傳失敗（不影響本地備份）:', uploadError.message);
            result.r2Upload = {
                uploaded: false,
                reason: uploadError.message
            };
        }
        console.log(`✅ 備份完成: ${result.fileName}`);
        return result;
    } catch (error) {
        console.error('❌ 資料庫備份失敗:', error.message);
        throw error;
    }
}

async function performSystemBackup() {
    try {
        console.log('\n[全系統備份任務] 開始執行...');
        const usePostgreSQL = !!process.env.DATABASE_URL;
        let result;
        if (usePostgreSQL) {
            result = await backupPostgreSQLSystem(process.env.DATABASE_URL);
        } else {
            const dbPath = path.join(__dirname, 'bookings.db');
            result = await backupSQLiteSystem(dbPath);
        }
        try {
            const client = getR2Client();
            if (client) {
                const safeName = path.basename(String(result.fileName || '').trim());
                const key = `${R2_BACKUP_PREFIX}/_system/${safeName}`;
                const contentType = safeName.endsWith('.json') ? 'application/json' : 'application/octet-stream';
                await client.send(new PutObjectCommand({
                    Bucket: R2_BUCKET_NAME,
                    Key: key,
                    Body: fs.readFileSync(result.filePath),
                    ContentType: contentType,
                    Metadata: { scope: 'system', source: 'booking-system-backup' }
                }));
                result.r2Upload = { uploaded: true, bucket: R2_BUCKET_NAME, key };
            } else {
                result.r2Upload = { uploaded: false, reason: 'R2 自動上傳未啟用或缺少必要環境變數' };
            }
        } catch (uploadError) {
            console.error('⚠️ 全系統備份上傳 R2 失敗（不影響本地備份）:', uploadError.message);
            result.r2Upload = { uploaded: false, reason: uploadError.message };
        }
        console.log(`✅ 全系統備份完成: ${result.fileName}`);
        return result;
    } catch (error) {
        console.error('❌ 全系統備份失敗:', error.message);
        throw error;
    }
}

/**
 * 清理舊備份（保留最近 N 天）
 */
async function cleanupOldBackups(daysToKeep = 30, tenantId) {
    try {
        const tenantDir = getTenantBackupDir(tenantId);
        
        const files = fs.readdirSync(tenantDir);
        const now = new Date();
        const cutoffDate = new Date(now);
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
        
        let deletedCount = 0;
        let totalSizeFreed = 0;
        
        for (const file of files) {
            // 只處理備份檔案
            if (!file.startsWith('backup_')) {
                continue;
            }
            
            const filePath = path.join(tenantDir, file);
            const stats = fs.statSync(filePath);
            const fileDate = stats.mtime;
            
            // 如果檔案超過保留期限，刪除
            if (fileDate < cutoffDate) {
                totalSizeFreed += stats.size;
                fs.unlinkSync(filePath);
                deletedCount++;
                console.log(`🗑️  刪除舊備份: ${file}`);
            }
        }
        
        if (deletedCount > 0) {
            const sizeFreedMB = (totalSizeFreed / (1024 * 1024)).toFixed(2);
            console.log(`✅ 清理完成: 刪除 ${deletedCount} 個舊備份，釋放 ${sizeFreedMB} MB`);
        } else {
            console.log('✅ 清理完成: 沒有需要刪除的舊備份');
        }
        
        return {
            deletedCount,
            totalSizeFreed,
            totalSizeFreedMB: parseFloat((totalSizeFreed / (1024 * 1024)).toFixed(2))
        };
    } catch (error) {
        console.error('❌ 清理舊備份失敗:', error.message);
        throw error;
    }
}

/**
 * 取得備份列表
 */
function getBackupList(tenantId) {
    try {
        const tenantDir = getTenantBackupDir(tenantId);
        
        const files = fs.readdirSync(tenantDir);
        const backups = [];
        
        for (const file of files) {
            if (!file.startsWith('backup_')) {
                continue;
            }
            
            const filePath = path.join(tenantDir, file);
            const stats = fs.statSync(filePath);
            
            backups.push({
                fileName: file,
                filePath: filePath,
                fileSize: stats.size,
                fileSizeMB: parseFloat((stats.size / (1024 * 1024)).toFixed(2)),
                createdAt: stats.birthtime,
                modifiedAt: stats.mtime
            });
        }
        
        // 按建立時間排序（最新的在前）
        backups.sort((a, b) => b.createdAt - a.createdAt);
        
        return backups;
    } catch (error) {
        console.error('❌ 取得備份列表失敗:', error.message);
        throw error;
    }
}

/**
 * 取得備份統計資訊
 */
function getBackupStats(tenantId) {
    try {
        const backups = getBackupList(tenantId);
        const totalSize = backups.reduce((sum, backup) => sum + backup.fileSize, 0);
        const totalSizeMB = parseFloat((totalSize / (1024 * 1024)).toFixed(2));
        
        return {
            totalBackups: backups.length,
            totalSize: totalSize,
            totalSizeMB: totalSizeMB,
            oldestBackup: backups.length > 0 ? backups[backups.length - 1].createdAt : null,
            newestBackup: backups.length > 0 ? backups[0].createdAt : null
        };
    } catch (error) {
        console.error('❌ 取得備份統計失敗:', error.message);
        throw error;
    }
}

function getSystemBackupList() {
    try {
        const systemDir = getSystemBackupDir();
        const files = fs.readdirSync(systemDir);
        const backups = [];
        for (const file of files) {
            if (!file.startsWith('system_backup_')) continue;
            const filePath = path.join(systemDir, file);
            const stats = fs.statSync(filePath);
            backups.push({
                fileName: file,
                filePath,
                fileSize: stats.size,
                fileSizeMB: parseFloat((stats.size / (1024 * 1024)).toFixed(2)),
                createdAt: stats.birthtime,
                modifiedAt: stats.mtime
            });
        }
        backups.sort((a, b) => b.createdAt - a.createdAt);
        return backups;
    } catch (error) {
        console.error('❌ 取得全系統備份列表失敗:', error.message);
        throw error;
    }
}

function getSystemBackupStats() {
    const backups = getSystemBackupList();
    const totalSize = backups.reduce((sum, backup) => sum + backup.fileSize, 0);
    return {
        totalBackups: backups.length,
        totalSize,
        totalSizeMB: parseFloat((totalSize / (1024 * 1024)).toFixed(2)),
        oldestBackup: backups.length > 0 ? backups[backups.length - 1].createdAt : null,
        newestBackup: backups.length > 0 ? backups[0].createdAt : null
    };
}

/**
 * 刪除指定備份檔案
 */
function deleteBackup(fileName, tenantId) {
    try {
        const tenantDir = getTenantBackupDir(tenantId);
        
        // 防止路徑遍歷攻擊
        const safeName = path.basename(fileName);
        if (!safeName.startsWith('backup_')) {
            throw new Error('無效的備份檔案名稱');
        }
        
        const filePath = path.join(tenantDir, safeName);
        
        if (!fs.existsSync(filePath)) {
            throw new Error('備份檔案不存在');
        }
        
        const stats = fs.statSync(filePath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        fs.unlinkSync(filePath);
        
        console.log(`🗑️ 已刪除備份: ${safeName} (${fileSizeMB} MB)`);
        
        return {
            success: true,
            fileName: safeName,
            fileSizeMB: parseFloat(fileSizeMB)
        };
    } catch (error) {
        console.error('❌ 刪除備份失敗:', error.message);
        throw error;
    }
}

/**
 * 還原 PostgreSQL 備份（從 JSON 備份檔案）
 */
async function restorePostgreSQL(databaseUrl, fileName, tenantId, customDir = null) {
    try {
        const tenantDir = customDir || getTenantBackupDir(tenantId);
        
        const safeName = path.basename(fileName);
        const filePath = path.join(tenantDir, safeName);
        
        if (!fs.existsSync(filePath)) {
            throw new Error('備份檔案不存在');
        }
        
        console.log(`🔄 開始還原 PostgreSQL 備份: ${safeName}`);
        
        // 讀取備份檔案
        const rawData = fs.readFileSync(filePath, 'utf8');
        const backupData = JSON.parse(rawData);
        
        if (!backupData.metadata || backupData.metadata.type !== 'postgresql_json_backup') {
            throw new Error('無效的備份檔案格式，僅支援 JSON 格式備份還原');
        }
        
        // 建立獨立連線池
        const pool = new Pool({
            connectionString: databaseUrl,
            ssl: databaseUrl.includes('railway') ? { rejectUnauthorized: false } : false
        });
        
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            const tables = backupData.metadata.tables || Object.keys(backupData.data);
            let restoredTables = 0;
            let totalRowsRestored = 0;

            // 僅處理有資料的表（避免白跑）
            const tablesWithRows = (tables || []).filter((t) => {
                const td = backupData.data?.[t];
                return td && Array.isArray(td.rows) && td.rows.length > 0;
            });

            // 還原順序：先父表後子表（最小化 FK 失敗）
            const priority = [
                // core
                'tenants',
                'roles',
                'admins',
                'users',
                'plans',
                'subscriptions',
                'invoices',
                'settings',
                // business
                'buildings',
                'room_types',
                'room_type_inventory',
                'prices',
                'customers',
                'bookings',
                // misc
                'holidays',
                'email_templates',
                'payment_events',
                'tenant_verifications',
                'promo_codes',
                'promo_code_usages',
                'member_levels',
                'action_logs'
            ];
            const priorityIndex = new Map(priority.map((name, idx) => [name, idx]));
            const orderedTables = [...tablesWithRows].sort((a, b) => {
                const ai = priorityIndex.has(a) ? priorityIndex.get(a) : 9999;
                const bi = priorityIndex.has(b) ? priorityIndex.get(b) : 9999;
                if (ai !== bi) return ai - bi;
                return String(a).localeCompare(String(b));
            });

            // Phase 1: 先清空所有表（避免後面 TRUNCATE ... CASCADE 把先插入的資料清掉）
            for (const table of orderedTables) {
                await client.query(`TRUNCATE TABLE "${table}" CASCADE`);
            }

            // Phase 2: 再依順序插入
            for (const table of orderedTables) {
                const tableData = backupData.data[table];
                try {
                    const columns = Object.keys(tableData.rows[0]);
                    const columnNames = columns.map((c) => `"${c}"`).join(', ');

                    for (const row of tableData.rows) {
                        const values = columns.map((c) => row[c]);
                        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
                        await client.query(
                            `INSERT INTO "${table}" (${columnNames}) VALUES (${placeholders})`,
                            values
                        );
                    }

                    if (columns.includes('id')) {
                        await client.query(
                            `
                            SELECT setval(pg_get_serial_sequence('"${table}"', 'id'),
                                COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)
                        `
                        ).catch(() => {});
                    }

                    restoredTables++;
                    totalRowsRestored += tableData.rows.length;
                    console.log(`  ✅ ${table}: 還原 ${tableData.rows.length} 筆資料`);
                } catch (tableError) {
                    console.error(`  ❌ 還原 ${table} 失敗:`, tableError.message);
                    throw tableError;
                }
            }
            
            await client.query('COMMIT');
            
            console.log(`✅ PostgreSQL 還原完成: ${restoredTables} 個資料表, ${totalRowsRestored} 筆資料`);
            
            return {
                success: true,
                fileName: safeName,
                restoredTables,
                totalRowsRestored
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
            await pool.end();
        }
    } catch (error) {
        console.error('❌ PostgreSQL 還原失敗:', error.message);
        throw error;
    }
}

/**
 * 還原 SQLite 備份
 */
async function restoreSQLite(fileName, tenantId, customDir = null) {
    try {
        const tenantDir = customDir || getTenantBackupDir(tenantId);
        
        const safeName = path.basename(fileName);
        const filePath = path.join(tenantDir, safeName);
        
        if (!fs.existsSync(filePath)) {
            throw new Error('備份檔案不存在');
        }
        
        if (!safeName.endsWith('.db')) {
            throw new Error('無效的 SQLite 備份檔案格式');
        }
        
        const dbPath = path.join(__dirname, 'bookings.db');
        
        // 先備份目前的資料庫（安全措施）
        const now = new Date();
        const dateStr = now.toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0];
        const preRestoreBackup = `backup_pre_restore_${dateStr}.db`;
        const preRestorePath = path.join(tenantDir, preRestoreBackup);
        
        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, preRestorePath);
            console.log(`📦 還原前備份: ${preRestoreBackup}`);
        }
        
        // 覆蓋目前的資料庫檔案
        fs.copyFileSync(filePath, dbPath);
        
        const stats = fs.statSync(dbPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        console.log(`✅ SQLite 還原完成: ${safeName} (${fileSizeMB} MB)`);
        
        return {
            success: true,
            fileName: safeName,
            fileSizeMB: parseFloat(fileSizeMB),
            preRestoreBackup
        };
    } catch (error) {
        console.error('❌ SQLite 還原失敗:', error.message);
        throw error;
    }
}

/**
 * 還原備份（自動偵測資料庫類型）
 */
async function restoreBackup(fileName, tenantId) {
    try {
        console.log(`\n[還原任務] 開始還原備份: ${fileName}`);
        
        const usePostgreSQL = !!process.env.DATABASE_URL;
        
        if (usePostgreSQL) {
            return await restorePostgreSQL(process.env.DATABASE_URL, fileName, tenantId);
        } else {
            return await restoreSQLite(fileName, tenantId);
        }
    } catch (error) {
        console.error('❌ 還原備份失敗:', error.message);
        throw error;
    }
}

function assertSafeSystemBackupBasename(name) {
    const raw = String(name || '');
    if (raw.includes('..') || /[/\\]/.test(raw)) {
        throw new Error('無效的備份檔案名稱');
    }
    const base = path.basename(raw);
    if (!/^system_backup_[a-zA-Z0-9._-]+\.(json|db)$/i.test(base)) {
        throw new Error('無效的全系統備份檔案名稱');
    }
    return base;
}

async function restoreSystemBackup(fileName) {
    try {
        const systemDir = getSystemBackupDir();
        const safeName = assertSafeSystemBackupBasename(fileName);
        const filePath = path.join(systemDir, safeName);
        if (!fs.existsSync(filePath)) {
            throw new Error('備份檔案不存在');
        }
        const usePostgreSQL = !!process.env.DATABASE_URL;
        if (usePostgreSQL) {
            return await restorePostgreSQL(process.env.DATABASE_URL, safeName, null, systemDir);
        }
        return await restoreSQLite(safeName, null, systemDir);
    } catch (error) {
        console.error('❌ 全系統備份還原失敗:', error.message);
        throw error;
    }
}

/**
 * 驗證備份檔 basename（防路徑遍歷、僅允許 backup_*.json / backup_*.db）
 */
function assertSafeBackupBasename(name) {
    const raw = String(name || '');
    if (raw.includes('..') || /[/\\]/.test(raw)) {
        throw new Error('無效的備份檔案名稱');
    }
    const base = path.basename(raw);
    if (!/^backup_[a-zA-Z0-9._-]+\.(json|db)$/i.test(base)) {
        throw new Error('無效的備份檔案名稱（須為 backup_ 開頭，副檔名 .json 或 .db）');
    }
    return base;
}

/**
 * 下載用：回傳安全路徑
 */
function getBackupFileForDownload(fileName, tenantId) {
    const tenantDir = getTenantBackupDir(tenantId);
    const safeName = assertSafeBackupBasename(fileName);
    const filePath = path.join(tenantDir, safeName);
    if (!fs.existsSync(filePath)) {
        throw new Error('備份檔案不存在');
    }
    return { safeName, filePath };
}

/**
 * 全系統下載用：回傳安全路徑
 */
function getSystemBackupFileForDownload(fileName) {
    const systemDir = getSystemBackupDir();
    const safeName = assertSafeSystemBackupBasename(fileName);
    const filePath = path.join(systemDir, safeName);
    if (!fs.existsSync(filePath)) {
        throw new Error('備份檔案不存在');
    }
    return { safeName, filePath };
}

/**
 * 上傳備份至備份目錄（與手動備份相同位置）
 */
function saveUploadedBackup(buffer, originalName, tenantId) {
    const tenantDir = getTenantBackupDir(tenantId);
    const safeName = assertSafeBackupBasename(originalName);
    const dest = path.join(tenantDir, safeName);
    if (fs.existsSync(dest)) {
        throw new Error('已存在同名備份檔，請先刪除或使用不同檔名');
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error('檔案內容為空');
    }

    const usePg = !!process.env.DATABASE_URL;

    if (safeName.endsWith('.json')) {
        if (!usePg) {
            throw new Error('目前為 SQLite 環境，請上傳 .db 備份檔（本機備份為複製 bookings.db）');
        }
        let data;
        try {
            data = JSON.parse(buffer.toString('utf8'));
        } catch (e) {
            throw new Error('JSON 備份格式無法解析');
        }
        if (!data.metadata || typeof data.metadata !== 'object') {
            throw new Error('不是有效的系統 JSON 備份（缺少 metadata）');
        }
        if (data.metadata.type !== 'postgresql_json_backup') {
            throw new Error('目前為 PostgreSQL 環境，僅能上傳本系統產生的 JSON 備份');
        }
    } else if (safeName.endsWith('.db')) {
        if (usePg) {
            throw new Error('目前為 PostgreSQL 環境，請上傳 .json 備份檔，勿上傳 .db');
        }
        const header = buffer.slice(0, 16).toString('utf8');
        if (!header.startsWith('SQLite format 3')) {
            throw new Error('不是有效的 SQLite 備份檔（檔頭不符）');
        }
    }

    fs.writeFileSync(dest, buffer);
    const stats = fs.statSync(dest);
    const fileSizeMB = parseFloat((stats.size / (1024 * 1024)).toFixed(2));
    return {
        fileName: safeName,
        filePath: dest,
        fileSize: stats.size,
        fileSizeMB
    };
}

module.exports = {
    performBackup,
    performSystemBackup,
    cleanupOldBackups,
    getBackupList,
    getBackupStats,
    getSystemBackupList,
    getSystemBackupStats,
    deleteBackup,
    restoreBackup,
    restoreSystemBackup,
    backupSQLite,
    backupPostgreSQL,
    getBackupFileForDownload,
    getSystemBackupFileForDownload,
    saveUploadedBackup
};

