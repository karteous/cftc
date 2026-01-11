async function initDatabase(config) {
    console.log("开始数据库初始化...");
    if (!config || !config.database) {
        console.error("数据库配置缺失");
        throw new Error("数据库配置无效，请检查D1数据库是否正确绑定");
    }
    if (!config.fileCache) {
        config.fileCache = new Map();
        config.fileCacheTTL = 3600000;
    }
    const maxRetries = 3;
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`正在测试数据库连接... (尝试 ${attempt}/${maxRetries})`);
            await config.database.prepare("SELECT 1").run();
            console.log("数据库连接成功");
            console.log("正在验证数据库结构...");
            const structureValid = await validateDatabaseStructure(config);
            if (!structureValid) {
                throw new Error("数据库结构验证失败");
            }
            console.log("数据库初始化成功");
            return true;
        } catch (error) {
            lastError = error;
            console.error(`数据库初始化尝试 ${attempt} 失败:`, error);
            if (error.message.includes('no such table')) {
                console.log("检测到数据表不存在，尝试创建...");
                try {
                    await recreateAllTables(config);
                    console.log("数据表创建成功");
                    return true;
                } catch (tableError) {
                    console.error("创建数据表失败:", tableError);
                }
            }
            if (attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                console.log(`等待 ${delay}ms 后重试...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw new Error(`数据库初始化失败 (${maxRetries} 次尝试): ${lastError?.message || '未知错误'}`);
}
async function recreateAllTables(config) {
    try {
        await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
        await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS user_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL UNIQUE,
        storage_type TEXT DEFAULT 'telegram',
        current_category_id INTEGER,
        waiting_for TEXT,
        editing_file_id TEXT,
        FOREIGN KEY (current_category_id) REFERENCES categories(id)
      )
    `).run();
        await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        fileId TEXT,
        message_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        file_name TEXT,
        file_size INTEGER,
        mime_type TEXT,
        storage_type TEXT DEFAULT 'telegram',
        category_id INTEGER,
        chat_id TEXT,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      )
    `).run();
        await config.database.prepare(`
      INSERT OR IGNORE INTO categories (name) VALUES ('默认分类')
    `).run();
        return true;
    } catch (error) {
        console.error("重新创建表失败:", error);
        throw error;
    }
}
async function validateDatabaseStructure(config) {
    try {
        const tables = ['categories', 'user_settings', 'files'];
        for (const table of tables) {
            try {
                await config.database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).run();
            } catch (error) {
                if (error.message.includes('no such table')) {
                    console.log(`表 ${table} 不存在，尝试重新创建所有表...`);
                    await recreateAllTables(config);
                    return true;
                }
                throw error;
            }
        }
        const tableStructures = {
            categories: [
                { name: 'id', type: 'INTEGER' },
                { name: 'name', type: 'TEXT' },
                { name: 'created_at', type: 'DATETIME' }
            ],
            user_settings: [
                { name: 'id', type: 'INTEGER' },
                { name: 'chat_id', type: 'TEXT' },
                { name: 'storage_type', type: 'TEXT' },
                { name: 'current_category_id', type: 'INTEGER' },
                { name: 'waiting_for', type: 'TEXT' },
                { name: 'editing_file_id', type: 'TEXT' }
            ],
            files: [
                { name: 'id', type: 'INTEGER' },
                { name: 'url', type: 'TEXT' },
                { name: 'fileId', type: 'TEXT' },
                { name: 'message_id', type: 'INTEGER' },
                { name: 'created_at', type: 'DATETIME' },
                { name: 'file_name', type: 'TEXT' },
                { name: 'file_size', type: 'INTEGER' },
                { name: 'mime_type', type: 'TEXT' },
                { name: 'storage_type', type: 'TEXT' },
                { name: 'category_id', type: 'INTEGER' },
                { name: 'chat_id', type: 'TEXT' }
            ]
        };
        for (const [table, expectedColumns] of Object.entries(tableStructures)) {
            const tableInfo = await config.database.prepare(`PRAGMA table_info(${table})`).all();
            const actualColumns = tableInfo.results;
            for (const expectedColumn of expectedColumns) {
                const found = actualColumns.some(col =>
                    col.name.toLowerCase() === expectedColumn.name.toLowerCase() &&
                    col.type.toUpperCase().includes(expectedColumn.type)
                );
                if (!found) {
                    console.log(`表 ${table} 缺少列 ${expectedColumn.name}，尝试添加...`);
                    try {
                        await config.database.prepare(`ALTER TABLE ${table} ADD COLUMN ${expectedColumn.name} ${expectedColumn.type}`).run();
                    } catch (error) {
                        if (!error.message.includes('duplicate column name')) {
                            throw error;
                        }
                    }
                }
            }
        }
        console.log('检查默认分类...');
        const defaultCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?')
            .bind('默认分类').first();
        if (!defaultCategory) {
            console.log('默认分类不存在，正在创建...');
            try {
                const result = await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
                    .bind('默认分类', Date.now()).run();
                const newDefaultId = result.meta && result.meta.last_row_id;
                console.log(`默认分类创建成功，ID: ${newDefaultId}`);
                if (newDefaultId) {
                    const filesResult = await config.database.prepare('SELECT COUNT(*) as count FROM files WHERE category_id IS NULL').first();
                    if (filesResult && filesResult.count > 0) {
                        console.log(`发现 ${filesResult.count} 个无分类文件，将它们分配到默认分类...`);
                        await config.database.prepare('UPDATE files SET category_id = ? WHERE category_id IS NULL')
                            .bind(newDefaultId).run();
                    }
                    const settingsResult = await config.database.prepare('SELECT COUNT(*) as count FROM user_settings WHERE current_category_id IS NULL').first();
                    if (settingsResult && settingsResult.count > 0) {
                        console.log(`发现 ${settingsResult.count} 条用户设置没有当前分类，更新为默认分类...`);
                        await config.database.prepare('UPDATE user_settings SET current_category_id = ? WHERE current_category_id IS NULL')
                            .bind(newDefaultId).run();
                    }
                }
            } catch (error) {
                console.error('创建默认分类失败:', error);
                throw new Error('无法创建默认分类: ' + error.message);
            }
        } else {
            console.log(`默认分类存在，ID: ${defaultCategory.id}`);
        }
        const checkAgain = await config.database.prepare('SELECT id FROM categories WHERE name = ?')
            .bind('默认分类').first();
        if (!checkAgain) {
            throw new Error('验证失败：即使尝试创建后，默认分类仍然不存在');
        }
        return true;
    } catch (error) {
        console.error('验证数据库结构时出错:', error);
        return false;
    }
}
async function recreateCategoriesTable(config) {
    try {
        const existingData = await config.database.prepare('SELECT * FROM categories').all();
        await config.database.prepare('DROP TABLE IF EXISTS categories').run();
        await config.database.prepare(`
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      )
    `).run();
        if (existingData && existingData.results && existingData.results.length > 0) {
            for (const row of existingData.results) {
                await config.database.prepare('INSERT OR IGNORE INTO categories (id, name, created_at) VALUES (?, ?, ?)')
                    .bind(row.id || null, row.name || '未命名分类', row.created_at || Date.now()).run();
            }
            console.log(`已恢复 ${existingData.results.length} 个分类数据`);
        }
        console.log("分类表重建完成");
    } catch (error) {
        console.error(`重建分类表失败: ${error.message}`);
    }
}
async function recreateUserSettingsTable(config) {
    try {
        await config.database.prepare('DROP TABLE IF EXISTS user_settings').run();
        await config.database.prepare(`
      CREATE TABLE user_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL UNIQUE,
        storage_type TEXT DEFAULT 'r2',
        category_id INTEGER,
        custom_suffix TEXT,
        waiting_for TEXT,
        editing_file_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
        console.log('用户设置表重新创建成功');
        return true;
    } catch (error) {
        console.error('重新创建用户设置表失败:', error);
        return false;
    }
}
async function recreateFilesTable(config) {
    console.log('开始重建文件表...');
    try {
        console.log('备份现有数据...');
        const existingData = await config.database.prepare('SELECT * FROM files').all();
        console.log('删除现有表...');
        await config.database.prepare('DROP TABLE IF EXISTS files').run();
        console.log('创建新表...');
        await config.database.prepare(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        fileId TEXT NOT NULL,
        message_id INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        file_name TEXT,
        file_size INTEGER,
        mime_type TEXT,
        chat_id TEXT,
        storage_type TEXT NOT NULL DEFAULT 'telegram',
        category_id INTEGER,
        custom_suffix TEXT,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      )
    `).run();
        console.log('恢复数据...');
        if (existingData && existingData.results && existingData.results.length > 0) {
            console.log(`恢复 ${existingData.results.length} 条记录...`);
            for (const row of existingData.results) {
                const timestamp = row.created_at || Math.floor(Date.now() / 1000);
                const messageId = row.message_id || 0;
                try {
                    await config.database.prepare(`
            INSERT INTO files (
              url, fileId, message_id, created_at, file_name, file_size, 
              mime_type, chat_id, storage_type, category_id, custom_suffix
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
                        row.url,
                        row.fileId || row.url,
                        messageId,
                        timestamp,
                        row.file_name,
                        row.file_size,
                        row.mime_type,
                        row.chat_id,
                        row.storage_type || 'telegram',
                        row.category_id,
                        row.custom_suffix
                    ).run();
                } catch (e) {
                    console.error(`恢复记录失败: ${e.message}`, row);
                }
            }
        }
        console.log('文件表重建完成!');
        return true;
    } catch (error) {
        console.error('重建文件表失败:', error);
        return false;
    }
}
async function checkAndAddMissingColumns(config) {
    try {
        await ensureColumnExists(config, 'files', 'custom_suffix', 'TEXT');
        await ensureColumnExists(config, 'files', 'chat_id', 'TEXT');
        await ensureColumnExists(config, 'user_settings', 'custom_suffix', 'TEXT');
        await ensureColumnExists(config, 'user_settings', 'waiting_for', 'TEXT');
        await ensureColumnExists(config, 'user_settings', 'editing_file_id', 'TEXT');
        await ensureColumnExists(config, 'user_settings', 'current_category_id', 'INTEGER');
        return true;
    } catch (error) {
        console.error('检查并添加缺失列失败:', error);
        return false;
    }
}
async function ensureColumnExists(config, tableName, columnName, columnType) {
    console.log(`确保列 ${columnName} 存在于表 ${tableName} 中...`);
    try {
        console.log(`检查列 ${columnName} 是否存在于 ${tableName}...`);
        const tableInfo = await config.database.prepare(`PRAGMA table_info(${tableName})`).all();
        const columnExists = tableInfo.results.some(col => col.name === columnName);
        if (columnExists) {
            console.log(`列 ${columnName} 已存在于表 ${tableName} 中`);
            return true;
        }
        console.log(`列 ${columnName} 不存在于表 ${tableName}，尝试添加...`);
        try {
            await config.database.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`).run();
            console.log(`列 ${columnName} 已成功添加到表 ${tableName}`);
            return true;
        } catch (alterError) {
            console.warn(`添加列 ${columnName} 到 ${tableName} 时发生错误: ${alterError.message}. 尝试再次检查列是否存在...`, alterError);
            const tableInfoAfterAttempt = await config.database.prepare(`PRAGMA table_info(${tableName})`).all();
            if (tableInfoAfterAttempt.results.some(col => col.name === columnName)) {
                console.log(`列 ${columnName} 在添加尝试失败后被发现存在于表 ${tableName} 中。`);
                return true;
            } else {
                console.error(`添加列 ${columnName} 到 ${tableName} 失败，并且再次检查后列仍不存在。`);
                return false;
            }
        }
    } catch (error) {
        console.error(`检查或添加表 ${tableName} 中的列 ${columnName} 时发生严重错误: ${error.message}`, error);
        return false;
    }
}
async function setWebhook(webhookUrl, botToken) {
    if (!botToken) {
        console.log('未配置Telegram机器人令牌，跳过webhook设置');
        return true;
    }
    const maxRetries = 3;
    let retryCount = 0;
    while (retryCount < maxRetries) {
        try {
            console.log(`尝试设置webhook: ${webhookUrl}`);
            const response = await fetch(
                `https://api.telegram.org/bot${botToken}/setWebhook?url=${webhookUrl}`
            );
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`Telegram API错误: HTTP ${response.status} - ${errorText}`);
                retryCount++;
                continue;
            }
            const result = await response.json();
            if (!result.ok) {
                if (result.error_code === 429) {
                    const retryAfter = result.parameters?.retry_after || 1;
                    console.log(`请求频率限制，等待 ${retryAfter} 秒后重试...`);
                    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                    retryCount++;
                    continue;
                }
                console.error(`设置webhook失败: ${JSON.stringify(result)}`);
                return false;
            }
            console.log(`Webhook设置成功: ${webhookUrl}`);
            return true;
        } catch (error) {
            console.error(`设置webhook时出错: ${error.message}`);
            retryCount++;
            if (retryCount < maxRetries) {
                const delay = 1000 * Math.pow(2, retryCount);
                console.log(`等待 ${delay}ms 后重试...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    console.error('多次尝试后仍未能设置webhook');
    return false;
}
export default {
    async fetch(request, env) {
        if (!env.DATABASE) {
            console.error("缺少DATABASE配置");
            return new Response('缺少必要配置: DATABASE 环境变量未设置', { status: 500 });
        }
        const config = {
            domain: env.DOMAIN || request.headers.get("host") || '',
            database: env.DATABASE,
            username: env.USERNAME || '',
            password: env.PASSWORD || '',
            enableAuth: env.ENABLE_AUTH === 'true' || false,
            tgBotToken: env.TG_BOT_TOKEN || '',
            tgChatId: env.TG_CHAT_ID ? env.TG_CHAT_ID.split(",") : [],
            tgStorageChatId: env.TG_STORAGE_CHAT_ID || env.TG_CHAT_ID || '',
            cookie: Number(env.COOKIE) || 7,
            maxSizeMB: Number(env.MAX_SIZE_MB) || 20,
            bucket: env.BUCKET,
            fileCache: new Map(),
            fileCacheTTL: 3600000,
            buttonCache: new Map(),
            buttonCacheTTL: 600000,
            menuCache: new Map(),
            menuCacheTTL: 300000,
            notificationCache: '',
            notificationCacheTTL: 3600000,
            lastNotificationFetch: 0
        };
        if (config.enableAuth && (!config.username || !config.password)) {
            console.error("启用了认证但未配置用户名或密码");
            return new Response('认证配置错误: 缺少USERNAME或PASSWORD环境变量', { status: 500 });
        }
        const url = new URL(request.url);
        const { pathname } = url;
        console.log(`[Auth] Request Path: ${pathname}, Method: ${request.method}`);
        if (pathname === '/favicon.ico') {
            console.log('[Auth] Handling favicon.ico request.');
            return new Response(null, { status: 204 });
        }
        const isAuthEnabled = config.enableAuth;
        const isAuthenticated = authenticate(request, config);
        const isLoginPage = pathname === '/login';
        const isPublicApi = pathname === '/webhook' || pathname === '/config' || pathname === '/bing';
        console.log(`[Auth] isAuthEnabled: ${isAuthEnabled}, isAuthenticated: ${isAuthenticated}, isLoginPage: ${isLoginPage}, isPublicApi: ${isPublicApi}`);
        const protectedPaths = ['/', '/upload', '/admin', '/create-category', '/delete-category', '/update-suffix', '/delete', '/delete-multiple', '/search'];
        const requiresAuth = isAuthEnabled && protectedPaths.includes(pathname);
        console.log(`[Auth] Path requires authentication: ${requiresAuth}`);
        if (requiresAuth && !isAuthenticated && !isLoginPage) {
            console.log(`[Auth] FAILED: Accessing protected path ${pathname} without authentication. Redirecting to login.`);
            if (request.method === 'POST' || request.headers.get('Accept')?.includes('application/json')) {
                return new Response(JSON.stringify({ status: 0, error: "未授权访问", redirect: `${url.origin}/login` }), {
                    status: 401,
                    headers: {
                        'Content-Type': 'application/json;charset=UTF-8',
                        'Cache-Control': 'no-store'
                    }
                });
            }
            const redirectUrl = `${url.origin}/login?redirect=${encodeURIComponent(pathname + url.search)}`;
            return Response.redirect(redirectUrl, 302);
        }
        if (isAuthEnabled && isAuthenticated && isLoginPage) {
            const redirectTarget = url.searchParams.get('redirect') || '/upload';
            console.log(`[Auth] SUCCESS: Authenticated user accessing login page. Redirecting to ${redirectTarget}.`);
            return Response.redirect(`${url.origin}${redirectTarget}`, 302);
        }
        console.log(`[Auth] Check PASSED for path: ${pathname}`);
        try {
            if (!isPublicApi && !isLoginPage) {
                await initDatabase(config);
                console.log('[DB] Database initialized successfully.');
            } else {
                console.log('[DB] Skipping database initialization for public API or login page.');
            }
        } catch (error) {
            console.error(`[DB] Database initialization FAILED: ${error.message}`);
            return new Response(`数据库初始化失败: ${error.message}`, {
                status: 500,
                headers: {
                    'Content-Type': 'text/plain;charset=UTF-8',
                    'Cache-Control': 'no-store'
                }
            });
        }
        if (config.tgBotToken) {
            try {
                const webhookUrl = `https://${config.domain}/webhook`;
                console.log(`[Webhook] Attempting to set webhook to: ${webhookUrl}`);
                const webhookSet = await setWebhook(webhookUrl, config.tgBotToken);
                if (!webhookSet) {
                    console.error('[Webhook] FAILED to set webhook after retries.');
                } else {
                    console.log('[Webhook] Webhook set successfully (or already set).');
                }
            } catch (error) {
                console.error(`[Webhook] FAILED to set webhook due to error: ${error.message}`);
            }
        }
        const routes = {
            '/': async () => {
                console.log('[Route] Handling / request.');
                return handleUploadRequest(request, config);
            },
            '/login': async () => {
                console.log('[Route] Handling /login request.');
                return handleLoginRequest(request, config);
            },
            '/upload': async () => {
                console.log('[Route] Handling /upload request.');
                return handleUploadRequest(request, config);
            },
            '/admin': async () => {
                console.log('[Route] Handling /admin request.');
                return handleAdminRequest(request, config);
            },
            '/delete': () => handleDeleteRequest(request, config),
            '/delete-multiple': () => handleDeleteMultipleRequest(request, config),
            '/search': () => handleSearchRequest(request, config),
            '/create-category': () => handleCreateCategoryRequest(request, config),
            '/delete-category': () => handleDeleteCategoryRequest(request, config),
            '/update-suffix': () => handleUpdateSuffixRequest(request, config),
            '/config': () => {
                console.log('[Route] Handling /config request.');
                const safeConfig = { maxSizeMB: config.maxSizeMB };
                return new Response(JSON.stringify(safeConfig), {
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'public, max-age=3600'
                    }
                });
            },
            '/webhook': () => {
                console.log('[Route] Handling /webhook request.');
                return handleTelegramWebhook(request, config);
            },
            '/bing': () => {
                console.log('[Route] Handling /bing request.');
                return handleBingImagesRequest(request, config);
            }
        };
        const handler = routes[pathname];
        if (handler) {
            try {
                console.log(`[Route] Executing handler for ${pathname}`);
                const response = await handler();
                if (isAuthEnabled && requiresAuth && response.headers.get('Content-Type')?.includes('text/html')) {
                    response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
                    response.headers.set('Pragma', 'no-cache');
                    response.headers.set('Expires', '0');
                }
                return response;
            } catch (error) {
                console.error(`[Route] Error handling route ${pathname}:`, error);
                return new Response("服务器内部错误", { status: 500, headers: { 'Cache-Control': 'no-store' } });
            }
        }
        console.log(`[File] Handling file request for ${pathname}`);
        return await handleFileRequest(request, config);
    }
};
async function handleTelegramWebhook(request, config) {
    try {
        const update = await request.json();
        let chatId;
        let userId;
        if (update.message) {
            chatId = update.message.chat.id.toString();
            userId = update.message.from.id.toString();
            console.log(`[Webhook] Received message from chat ID: ${chatId}, User ID: ${userId}`);
            // --- Ignore group/supergroup messages --- 
            if (update.message.chat.type === 'group' || update.message.chat.type === 'supergroup') {
                console.log(`[Webhook] Ignoring message from group/supergroup chat ID: ${chatId}`);
                return new Response('OK');
            }
            // --------------------------------------
        } else if (update.callback_query) {
            chatId = update.callback_query.from.id.toString();
            userId = update.callback_query.from.id.toString();
            console.log(`[Webhook] Received callback_query from chat ID: ${chatId}, User ID: ${userId}`);
        } else {
            console.log('[Webhook] Received update without message or callback_query:', JSON.stringify(update));
            return new Response('OK');
        }
        // Check if the chatId is included in the allowed list
        if (config.tgChatId && config.tgChatId.length > 0 && !config.tgChatId.includes(chatId)) {
            console.log(`[Auth Check] FAILED: Chat ID ${chatId} (User ID: ${userId}) is not in the allowed list [${config.tgChatId.join(', ')}]. Ignoring update.`);
            if (config.tgBotToken) {
                await sendMessage(chatId, "你无权使用 请联系管理员授权", config.tgBotToken);
            } else {
                console.warn("[Auth Check] Cannot send unauthorized message: TG_BOT_TOKEN not configured.")
            }
            return new Response('OK');
        }
        console.log(`[Auth Check] PASSED: Chat ID ${chatId} (User ID: ${userId}) is allowed.`);
        let userSetting = await config.database.prepare('SELECT * FROM user_settings WHERE chat_id = ?').bind(chatId).first();
        if (!userSetting) {
            let defaultCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind('默认分类').first();
            let defaultCategoryId = null;
            if (!defaultCategory) {
                try {
                    console.log('默认分类不存在，为新用户创建...');
                    const result = await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
                        .bind('默认分类', Date.now()).run();
                    defaultCategoryId = result.meta && result.meta.last_row_id;
                    console.log(`新默认分类创建成功，ID: ${defaultCategoryId}`);
                } catch (error) {
                    console.error('为新用户创建默认分类失败:', error);
                }
            } else {
                defaultCategoryId = defaultCategory.id;
            }
            await config.database.prepare('INSERT INTO user_settings (chat_id, storage_type, current_category_id) VALUES (?, ?, ?)')
                .bind(chatId, 'r2', defaultCategoryId).run();
            userSetting = { chat_id: chatId, storage_type: 'r2', current_category_id: defaultCategoryId };
        }
        if (update.message) {
            if (userSetting.waiting_for === 'new_category' && update.message.text) {
                const categoryName = update.message.text.trim();
                try {
                    const existingCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind(categoryName).first();
                    if (existingCategory) {
                        await sendMessage(chatId, `⚠️ 分类"${categoryName}"已存在`, config.tgBotToken);
                    } else {
                        const time = Date.now();
                        await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)').bind(categoryName, time).run();
                        const newCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind(categoryName).first();
                        await config.database.prepare('UPDATE user_settings SET current_category_id = ?, waiting_for = NULL WHERE chat_id = ?').bind(newCategory.id, chatId).run();
                        await sendMessage(chatId, `✅ 分类"${categoryName}"创建成功并已设为当前分类`, config.tgBotToken);
                    }
                } catch (error) {
                    console.error('创建分类失败:', error);
                    await sendMessage(chatId, `❌ 创建分类失败: ${error.message}`, config.tgBotToken);
                }
                await config.database.prepare('UPDATE user_settings SET waiting_for = NULL WHERE chat_id = ?').bind(chatId).run();
                userSetting.waiting_for = null;
                if (categoryName) {
                    const newCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind(categoryName).first();
                    if (newCategory) {
                        userSetting.current_category_id = newCategory.id;
                    }
                }
                await sendPanel(chatId, userSetting, config);
                return new Response('OK');
            }
            else if (userSetting.waiting_for === 'new_suffix' && update.message.text && userSetting.editing_file_id) {
                const newSuffix = update.message.text.trim();
                const fileId = userSetting.editing_file_id;
                try {
                    const file = await config.database.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first();
                    if (!file) {
                        await sendMessage(chatId, "⚠️ 文件不存在或已被删除", config.tgBotToken);
                    } else {
                        const originalFileName = getFileName(file.url);
                        const fileExt = originalFileName.split('.').pop();
                        const newFileName = `${newSuffix}.${fileExt}`;
                        const fileUrl = `https://${config.domain}/${newFileName}`;
                        let success = false;
                        if (file.storage_type === 'telegram') {
                            await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                                .bind(fileUrl, file.id).run();
                            success = true;
                        }
                        else if (file.storage_type === 'r2' && config.bucket) {
                            try {
                                const fileId = file.fileId || originalFileName;
                                const r2File = await config.bucket.get(fileId);
                                if (r2File) {
                                    const fileData = await r2File.arrayBuffer();
                                    await storeFile(fileData, newFileName, r2File.httpMetadata.contentType, config);
                                    await deleteFile(fileId, config);
                                    await config.database.prepare('UPDATE files SET fileId = ?, url = ? WHERE id = ?')
                                        .bind(newFileName, fileUrl, file.id).run();
                                    success = true;
                                } else {
                                    await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                                        .bind(fileUrl, file.id).run();
                                    success = true;
                                }
                            } catch (error) {
                                console.error('处理R2文件重命名失败:', error);
                                await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                                    .bind(fileUrl, file.id).run();
                                success = true;
                            }
                        }
                        else {
                            await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                                .bind(fileUrl, file.id).run();
                            success = true;
                        }
                        if (success) {
                            await sendMessage(chatId, `✅ 后缀修改成功！\n\n新链接：${fileUrl}`, config.tgBotToken);
                        } else {
                            await sendMessage(chatId, "❌ 后缀修改失败，请稍后重试", config.tgBotToken);
                        }
                    }
                } catch (error) {
                    console.error('修改后缀失败:', error);
                    await sendMessage(chatId, `❌ 修改后缀失败: ${error.message}`, config.tgBotToken);
                }
                await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?').bind(chatId).run();
                userSetting.waiting_for = null;
                userSetting.editing_file_id = null;
                await sendPanel(chatId, userSetting, config);
                return new Response('OK');
            }
            else if (userSetting.waiting_for === 'delete_file_input' && update.message.text) {
                try {
                    await config.database.prepare('UPDATE user_settings SET waiting_for = NULL WHERE chat_id = ?')
                        .bind(chatId).run();
                    userSetting.waiting_for = null;
                    const userInput = update.message.text.trim();
                    let fileToDelete = null;
                    if (userInput.startsWith('http://') || userInput.startsWith('https://')) {
                        fileToDelete = await config.database.prepare(
                            'SELECT id, fileId, message_id, storage_type, url, file_name FROM files WHERE url = ? AND chat_id = ?'
                        ).bind(userInput, chatId).first();
                    } else {
                        let fileName = userInput;
                        if (!fileName.includes('.')) {
                            await sendMessage(chatId, "⚠️ 请输入完整的文件名称（包含扩展名）或完整URL", config.tgBotToken);
                            await sendPanel(chatId, userSetting, config);
                            return new Response('OK');
                        }
                        fileToDelete = await config.database.prepare(
                            'SELECT id, fileId, message_id, storage_type, url, file_name FROM files WHERE (file_name = ? OR url LIKE ?) AND chat_id = ? ORDER BY created_at DESC LIMIT 1'
                        ).bind(fileName, `%/${fileName}`, chatId).first();
                    }
                    if (!fileToDelete) {
                        await sendMessage(chatId, "⚠️ 未找到匹配的文件，请输入完整的文件名称或URL", config.tgBotToken);
                        await sendPanel(chatId, userSetting, config);
                        return new Response('OK');
                    }
                    const fileName = fileToDelete.file_name || getFileName(fileToDelete.url);
                    console.log(`[TG Delete] 找到匹配文件: ID=${fileToDelete.id}, 名称=${fileName}, URL=${fileToDelete.url}`);
                    console.log(`[TG Delete] 开始删除: ID=${fileToDelete.id}, 类型=${fileToDelete.storage_type}, TGMsgID=${fileToDelete.message_id}, R2ID=${fileToDelete.fileId}`);
                    let storageDeleteSuccess = false;
                    if (fileToDelete.storage_type === 'r2' && config.bucket && fileToDelete.fileId) {
                        try {
                            await config.bucket.delete(fileToDelete.fileId);
                            console.log(`[TG Delete] R2文件已删除: ${fileToDelete.fileId}`);
                            storageDeleteSuccess = true;
                        } catch (r2Error) {
                            console.error(`[TG Delete] 从R2删除失败: ${r2Error.message}`);
                        }
                    } else if (fileToDelete.storage_type === 'telegram' && fileToDelete.message_id && fileToDelete.message_id !== -1 && fileToDelete.message_id !== 0) {
                        try {
                            const deleteTgMsgResponse = await fetch(
                                `https://api.telegram.org/bot${config.tgBotToken}/deleteMessage?chat_id=${config.tgStorageChatId}&message_id=${fileToDelete.message_id}`
                            );
                            const deleteTgMsgResult = await deleteTgMsgResponse.json();
                            if (deleteTgMsgResponse.ok && deleteTgMsgResult.ok) {
                                console.log(`[TG Delete] Telegram消息已删除: ${fileToDelete.message_id}`);
                                storageDeleteSuccess = true;
                            } else {
                                console.warn(`[TG Delete] 删除Telegram消息失败 ${fileToDelete.message_id}: ${JSON.stringify(deleteTgMsgResult)}`);
                            }
                        } catch (tgError) {
                            console.error(`[TG Delete] 删除Telegram消息错误: ${tgError.message}`);
                        }
                    } else {
                        console.log(`[TG Delete] ID ${fileToDelete.id} 没有关联的存储文件/消息需要删除 (类型: ${fileToDelete.storage_type}, TGMsgID: ${fileToDelete.message_id}, R2ID: ${fileToDelete.fileId})`);
                        storageDeleteSuccess = true;
                    }
                    await config.database.prepare('DELETE FROM files WHERE id = ?').bind(fileToDelete.id).run();
                    console.log(`[TG Delete] 数据库记录已删除: ID=${fileToDelete.id}`);
                    const cacheKey = `file:${fileName}`;
                    if (config.fileCache && config.fileCache.has(cacheKey)) {
                        config.fileCache.delete(cacheKey);
                        console.log(`[TG Delete] 文件缓存已清除: ${cacheKey}`);
                    }
                    await sendMessage(chatId, `✅ 文件已成功删除: ${fileName}`, config.tgBotToken);
                    await sendPanel(chatId, userSetting, config);
                    return new Response('OK');
                } catch (error) {
                    console.error(`[TG Delete] 删除过程中出错:`, error);
                    await sendMessage(chatId, `❌ 删除文件时出错: ${error.message}`, config.tgBotToken);
                    await sendPanel(chatId, userSetting, config);
                    return new Response('OK');
                }
            }
            if (update.message.text === '/start') {
                await sendPanel(chatId, userSetting, config);
            }
            else if (update.message.photo || update.message.document || update.message.video || update.message.audio || update.message.voice || update.message.video_note) {
                console.log('收到文件上传:', JSON.stringify({
                    hasPhoto: !!update.message.photo,
                    hasDocument: !!update.message.document,
                    hasVideo: !!update.message.video,
                    hasAudio: !!update.message.audio,
                    hasVoice: !!update.message.voice,
                    hasVideoNote: !!update.message.video_note
                }));
                let file;
                let isDocument = false;
                if (update.message.document) {
                    file = update.message.document;
                    isDocument = true;
                } else if (update.message.video) {
                    file = update.message.video;
                    isDocument = true;
                } else if (update.message.audio) {
                    file = update.message.audio;
                    isDocument = true;
                } else if (update.message.voice) {
                    file = update.message.voice;
                    isDocument = true;
                } else if (update.message.video_note) {
                    file = update.message.video_note;
                    isDocument = true;
                } else if (update.message.photo) {
                    file = update.message.photo && update.message.photo.length ? update.message.photo[update.message.photo.length - 1] : null;
                    isDocument = false;
                }
                if (file) {
                    await handleMediaUpload(chatId, file, isDocument, config, userSetting);
                } else {
                    await sendMessage(chatId, "❌ 无法识别的文件类型", config.tgBotToken);
                }
            }
            else {
                const message = update.message;
                let fileField = null;
                for (const field in message) {
                    if (message[field] && typeof message[field] === 'object' && message[field].file_id) {
                        fileField = field;
                        break;
                    }
                }
                if (fileField) {
                    console.log(`找到未明确处理的文件类型: ${fileField}`, JSON.stringify(message[fileField]));
                    await handleMediaUpload(chatId, message[fileField], true, config, userSetting);
                } else if (userSetting.waiting_for === 'edit_suffix_input_file' && message.text) {
                    try {
                        const userInput = message.text.trim();
                        let fileToEdit = null;
                        if (userInput.startsWith('http://') || userInput.startsWith('https://')) {
                            fileToEdit = await config.database.prepare(
                                'SELECT id, url, file_name FROM files WHERE url = ? AND chat_id = ?'
                            ).bind(userInput, chatId).first();
                        } else {
                            let fileName = userInput;
                            if (!fileName.includes('.')) {
                                await sendMessage(chatId, "⚠️ 请输入完整的文件名称（包含扩展名）或完整URL", config.tgBotToken);
                                await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?')
                                    .bind(chatId).run();
                                userSetting.waiting_for = null;
                                userSetting.editing_file_id = null;
                                await sendPanel(chatId, userSetting, config);
                                return new Response('OK');
                            }
                            fileToEdit = await config.database.prepare(
                                'SELECT id, url, file_name FROM files WHERE (file_name = ? OR url LIKE ?) AND chat_id = ? ORDER BY created_at DESC LIMIT 1'
                            ).bind(fileName, `%/${fileName}`, chatId).first();
                        }
                        if (!fileToEdit) {
                            await sendMessage(chatId, "⚠️ 未找到匹配的文件，请输入完整的文件名称或URL", config.tgBotToken);
                            await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?')
                                .bind(chatId).run();
                            userSetting.waiting_for = null;
                            userSetting.editing_file_id = null;
                            await sendPanel(chatId, userSetting, config);
                            return new Response('OK');
                        }
                        const fileName = fileToEdit.file_name || getFileName(fileToEdit.url);
                        const fileNameParts = fileName.split('.');
                        const extension = fileNameParts.pop();
                        const currentSuffix = fileNameParts.join('.');
                        await config.database.prepare('UPDATE user_settings SET waiting_for = ?, editing_file_id = ? WHERE chat_id = ?')
                            .bind('edit_suffix_input_new', fileToEdit.id, chatId).run();
                        userSetting.waiting_for = 'edit_suffix_input_new';
                        userSetting.editing_file_id = fileToEdit.id;
                        await sendMessage(
                            chatId,
                            `📝 找到文件: ${fileName}\n当前后缀: ${currentSuffix}\n\n请回复此消息，输入文件的新后缀（不含扩展名）`,
                            config.tgBotToken
                        );
                        return new Response('OK');
                    } catch (error) {
                        console.error('处理修改后缀文件选择失败:', error);
                        await sendMessage(chatId, `❌ 处理失败: ${error.message}`, config.tgBotToken);
                        await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?')
                            .bind(chatId).run();
                        userSetting.waiting_for = null;
                        userSetting.editing_file_id = null;
                        await sendPanel(chatId, userSetting, config);
                        return new Response('OK');
                    }
                } else if (userSetting.waiting_for === 'edit_suffix_input_new' && message.text && userSetting.editing_file_id) {
                    const newSuffix = message.text.trim();
                    const fileId = userSetting.editing_file_id;
                    try {
                        const file = await config.database.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first();
                        if (!file) {
                            await sendMessage(chatId, "⚠️ 文件不存在或已被删除", config.tgBotToken);
                        } else {
                            const originalFileName = getFileName(file.url);
                            const fileExt = originalFileName.split('.').pop();
                            const newFileName = `${newSuffix}.${fileExt}`;
                            const fileUrl = `https://${config.domain}/${newFileName}`;
                            let success = false;
                            if (file.storage_type === 'telegram') {
                                await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                                    .bind(fileUrl, file.id).run();
                                success = true;
                            }
                            else if (file.storage_type === 'r2' && config.bucket) {
                                try {
                                    const fileId = file.fileId || originalFileName;
                                    const r2File = await config.bucket.get(fileId);
                                    if (r2File) {
                                        const fileData = await r2File.arrayBuffer();
                                        await storeFile(fileData, newFileName, r2File.httpMetadata.contentType, config);
                                        await deleteFile(fileId, config);
                                        await config.database.prepare('UPDATE files SET fileId = ?, url = ? WHERE id = ?')
                                            .bind(newFileName, fileUrl, file.id).run();
                                        success = true;
                                    } else {
                                        await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                                            .bind(fileUrl, file.id).run();
                                        success = true;
                                    }
                                } catch (error) {
                                    console.error('处理R2文件重命名失败:', error);
                                    await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                                        .bind(fileUrl, file.id).run();
                                    success = true;
                                }
                            }
                            else {
                                await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                                    .bind(fileUrl, file.id).run();
                                success = true;
                            }
                            if (success) {
                                await sendMessage(chatId, `✅ 后缀修改成功！\n\n新链接：${fileUrl}`, config.tgBotToken);
                            } else {
                                await sendMessage(chatId, "❌ 后缀修改失败，请稍后重试", config.tgBotToken);
                            }
                        }
                    } catch (error) {
                        console.error('修改后缀失败:', error);
                        await sendMessage(chatId, `❌ 修改后缀失败: ${error.message}`, config.tgBotToken);
                    }
                    await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?').bind(chatId).run();
                    userSetting.waiting_for = null;
                    userSetting.editing_file_id = null;
                    await sendPanel(chatId, userSetting, config);
                    return new Response('OK');
                } else if (message.text && message.text !== '/start') {
                    await sendMessage(chatId, "请发送图片或文件进行上传，或使用 /start 查看主菜单", config.tgBotToken);
                }
            }
        }
        else if (update.callback_query) {
            await handleCallbackQuery(update, config, userSetting);
        }
        return new Response('OK');
    } catch (error) {
        console.error('Error handling webhook:', error);
        return new Response('Error processing webhook', { status: 500 });
    }
}
async function sendPanel(chatId, userSetting, config) {
    try {
        const cacheKey = `menu:${chatId}:${userSetting.storage_type || 'default'}`;
        if (config.menuCache && config.menuCache.has(cacheKey)) {
            const cachedData = config.menuCache.get(cacheKey);
            if (Date.now() - cachedData.timestamp < config.menuCacheTTL) {
                console.log(`使用缓存的菜单: ${cacheKey}`);
                const response = await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: cachedData.menuData
                });
                if (!response.ok) {
                    config.menuCache.delete(cacheKey);
                    console.log(`缓存菜单发送失败，重新生成: ${await response.text()}`);
                } else {
                    return await response.json();
                }
            } else {
                config.menuCache.delete(cacheKey);
            }
        }
        const { messageBody, keyboard } = await generateMainMenu(chatId, userSetting, config);
        const menuData = JSON.stringify({
            chat_id: chatId,
            text: messageBody,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
        if (config.menuCache) {
            config.menuCache.set(cacheKey, {
                menuData,
                timestamp: Date.now()
            });
        }
        const response = await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: menuData
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`发送面板失败: ${errorText}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error('发送面板出错:', error);
        return null;
    }
}
async function generateMainMenu(chatId, userSetting, config) {
    const storageText = userSetting.storage_type === 'r2' ? 'R2对象存储' : 'Telegram存储';
    let categoryName = '未选择分类';
    const categoryPromise = userSetting.current_category_id ?
        config.database.prepare('SELECT name FROM categories WHERE id = ?')
            .bind(userSetting.current_category_id).first()
        : Promise.resolve(null);
    const statsPromise = config.database.prepare(`
    SELECT COUNT(*) as total_files, SUM(file_size) as total_size
    FROM files WHERE chat_id = ?
  `).bind(chatId).first();
    const notificationPromise = (async () => {
        const now = Date.now();
        if (!config.notificationCache || (now - config.lastNotificationFetch > config.notificationCacheTTL)) {
            try {
                console.log('[Notification] Fetching new notification...');
                config.notificationCache = await fetchNotification();
                config.lastNotificationFetch = now;
            } catch (error) {
                console.error('[Notification] Failed to fetch notification:', error);
                config.notificationCache = config.notificationCache || '';
            }
        }
        return config.notificationCache;
    })();
    const [categoryResult, stats, notificationText] = await Promise.all([
        categoryPromise,
        statsPromise,
        notificationPromise
    ]);
    if (categoryResult) {
        categoryName = categoryResult.name;
    }
    const defaultNotification =
        "➡️ 现在您可以直接发送图片或文件，上传完成后会自动生成图床直链\n" +
        "➡️ 所有上传的文件都可以在网页后台管理，支持删除、查看、分类等操作";
    const messageBody = `☁️ <b>图床助手v1</b>
  📂 当前存储：${storageText}
  📁 当前分类：${categoryName}
  📊 已上传：${stats && stats.total_files ? stats.total_files : 0} 个文件
  💾 已用空间：${formatSize(stats && stats.total_size ? stats.total_size : 0)}
  ${notificationText || defaultNotification}
  👇 请选择操作：`;
    const keyboard = getKeyboardLayout(userSetting);
    return { messageBody, keyboard };
}
function getKeyboardLayout(userSetting) {
    const storageType = userSetting.storage_type || 'telegram';
    return {
        inline_keyboard: [
            [
                { text: "📤 切换存储", callback_data: "switch_storage" },
                { text: "📋 选择分类", callback_data: "list_categories" }
            ],
            [
                { text: "📝 创建分类", callback_data: "create_category" },
                { text: "📊 R2统计", callback_data: "r2_stats" }
            ],
            [
                { text: "📂 最近文件", callback_data: "recent_files" },
                { text: "✏️ 修改后缀", callback_data: "edit_suffix_input" },
                { text: "🗑️ 删除文件", callback_data: "delete_file_input" }
            ],
            [
                { text: "📦 本项目GitHub地址", url: "https://github.com/iawooo/cftc" }
            ]
        ]
    };
}
async function handleCallbackQuery(update, config, userSetting) {
    const chatId = update.callback_query.from.id.toString();
    const cbData = update.callback_query.data;
    const answerPromise = fetch(`https://api.telegram.org/bot${config.tgBotToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: update.callback_query.id })
    }).catch(error => {
        console.error('确认回调查询失败:', error);
    });
    try {
        if (userSetting.waiting_for && !cbData.startsWith('delete_file_do_')) {
            if (!(userSetting.waiting_for === 'new_suffix' && cbData.startsWith('edit_suffix_file_')) &&
                !(userSetting.waiting_for === 'new_category' && cbData === 'create_category') &&
                !(userSetting.waiting_for === 'delete_file_input' && cbData === 'delete_file_input') &&
                !(userSetting.waiting_for === 'edit_suffix_input_file' && cbData === 'edit_suffix_input') &&
                !(userSetting.waiting_for === 'edit_suffix_input_new' && userSetting.editing_file_id)) {
                await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?')
                    .bind(chatId).run();
                userSetting.waiting_for = null;
                userSetting.editing_file_id = null;
            }
        }
        const cacheKey = `button:${chatId}:${cbData}`;
        if (config.buttonCache && config.buttonCache.has(cacheKey) && !cbData.startsWith('delete_file_confirm_') && !cbData.startsWith('delete_file_do_')) {
            const cachedData = config.buttonCache.get(cacheKey);
            if (Date.now() - cachedData.timestamp < config.buttonCacheTTL) {
                console.log(`使用缓存的按钮响应: ${cacheKey}`);
                await answerPromise;
                if (cachedData.responseText) {
                    await sendMessage(chatId, cachedData.responseText, config.tgBotToken);
                }
                if (cachedData.sendPanel) {
                    await sendPanel(chatId, userSetting, config);
                }
                if (cachedData.replyMarkup) {
                    await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: chatId,
                            text: cachedData.replyText,
                            reply_markup: cachedData.replyMarkup,
                            parse_mode: 'HTML',
                            disable_web_page_preview: cachedData.disablePreview || false
                        })
                    });
                }
                return;
            } else {
                config.buttonCache.delete(cacheKey);
            }
        }
        if (cbData === 'switch_storage') {
            const newStorageType = userSetting.storage_type === 'r2' ? 'telegram' : 'r2';
            await Promise.all([
                config.database.prepare('UPDATE user_settings SET storage_type = ? WHERE chat_id = ?')
                    .bind(newStorageType, chatId).run(),
                answerPromise
            ]);
            if (config.buttonCache) {
                config.buttonCache.set(cacheKey, {
                    timestamp: Date.now(),
                    sendPanel: true
                });
            }
            await sendPanel(chatId, { ...userSetting, storage_type: newStorageType }, config);
        }
        else if (cbData === 'list_categories') {
            const categoriesPromise = config.database.prepare('SELECT id, name FROM categories').all();
            await answerPromise;
            const categories = await categoriesPromise;
            if (!categories.results || categories.results.length === 0) {
                await sendMessage(chatId, "⚠️ 暂无分类，请先创建分类", config.tgBotToken);
                return;
            }
            const categoriesText = categories.results.map((cat, i) =>
                `${i + 1}. ${cat.name}`
            ).join('\n');
            const keyboard = {
                inline_keyboard: categories.results.map(cat => [
                    { text: cat.name, callback_data: `set_category_${cat.id}` }
                ]).concat([[{ text: "« 返回", callback_data: "back_to_panel" }]])
            };
            if (config.buttonCache) {
                config.buttonCache.set(cacheKey, {
                    timestamp: Date.now(),
                    replyText: "📂 请选择要使用的分类：\n\n" + categoriesText,
                    replyMarkup: keyboard
                });
            }
            await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: "📂 请选择要使用的分类：\n\n" + categoriesText,
                    reply_markup: keyboard
                })
            });
        }
        else if (cbData === 'create_category') {
            if (config.buttonCache) {
                config.buttonCache.set(cacheKey, {
                    timestamp: Date.now(),
                    responseText: "📝 请回复此消息，输入新分类名称"
                });
            }
            await Promise.all([
                answerPromise,
                sendMessage(chatId, "📝 请回复此消息，输入新分类名称", config.tgBotToken),
                config.database.prepare('UPDATE user_settings SET waiting_for = ? WHERE chat_id = ?')
                    .bind('new_category', chatId).run()
            ]);
            userSetting.waiting_for = 'new_category';
        }
        else if (cbData.startsWith('set_category_')) {
            const categoryId = parseInt(cbData.split('_')[2]);
            const updatePromise = config.database.prepare(
                'UPDATE user_settings SET current_category_id = ? WHERE chat_id = ?'
            ).bind(categoryId, chatId).run();
            const categoryPromise = config.database.prepare(
                'SELECT name FROM categories WHERE id = ?'
            ).bind(categoryId).first();
            await answerPromise;
            const [_, category] = await Promise.all([updatePromise, categoryPromise]);
            const responseText = `✅ 已切换到分类: ${category?.name || '未知分类'}`;
            if (config.buttonCache) {
                config.buttonCache.set(`button:${chatId}:${cbData}`, {
                    timestamp: Date.now(),
                    responseText,
                    sendPanel: true
                });
            }
            await sendMessage(chatId, responseText, config.tgBotToken);
            await sendPanel(chatId, { ...userSetting, current_category_id: categoryId }, config);
        }
        else if (cbData === 'back_to_panel') {
            if (config.buttonCache) {
                config.buttonCache.set(cacheKey, {
                    timestamp: Date.now(),
                    sendPanel: true
                });
            }
            await answerPromise;
            if (userSetting.waiting_for) {
                await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?').bind(chatId).run();
                userSetting.waiting_for = null;
                userSetting.editing_file_id = null;
            }
            await sendPanel(chatId, userSetting, config);
        }
        else if (cbData === 'r2_stats') {
            const statsPromise = config.database.prepare(`
        SELECT COUNT(*) as total_files,
               SUM(file_size) as total_size
        FROM files WHERE chat_id = ? AND storage_type = 'r2'
      `).bind(chatId).first();
            await answerPromise;
            const stats = await statsPromise;
            const statsMessage = `📊 您的 R2 存储使用统计
  ─────────────
  📁 R2 文件数: ${stats.total_files || 0}
  💾 R2 存储量: ${formatSize(stats.total_size || 0)}`;
            if (config.buttonCache) {
                config.buttonCache.set(cacheKey, {
                    timestamp: Date.now(),
                    responseText: statsMessage
                });
            }
            await sendMessage(chatId, statsMessage, config.tgBotToken);
        }
        else if (cbData === 'edit_suffix') {
            await answerPromise;
            const recentFiles = await config.database.prepare(`
        SELECT id, url, fileId, file_name, created_at, storage_type
        FROM files
        WHERE chat_id = ?
        ORDER BY created_at DESC
        LIMIT 5
      `).bind(chatId).all();
            if (!recentFiles.results || recentFiles.results.length === 0) {
                await sendMessage(chatId, "⚠️ 您还没有上传过文件", config.tgBotToken);
                return;
            }
            const keyboard = {
                inline_keyboard: recentFiles.results.map(file => {
                    const fileName = file.file_name || getFileName(file.url);
                    return [{ text: fileName, callback_data: `edit_suffix_file_${file.id}` }];
                }).concat([[{ text: "« 返回", callback_data: "back_to_panel" }]])
            };
            await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: "📝 请选择要修改后缀的文件：",
                    reply_markup: keyboard
                })
            });
        }
        else if (cbData === 'recent_files') {
            const recentFilesPromise = config.database.prepare(`
        SELECT id, url, created_at, file_name, storage_type
        FROM files
        WHERE chat_id = ?
        ORDER BY created_at DESC
        LIMIT 10
      `).bind(chatId).all();
            await answerPromise;
            const recentFiles = await recentFilesPromise;
            if (!recentFiles.results || recentFiles.results.length === 0) {
                await sendMessage(chatId, "⚠️ 您还没有上传过文件", config.tgBotToken);
                return;
            }
            const filesList = recentFiles.results.map((file, i) => {
                const fileName = file.file_name || getFileName(file.url);
                const date = formatDate(file.created_at);
                const storageEmoji = file.storage_type === 'r2' ? '☁️' : '✈️';
                return `${i + 1}. ${fileName}\n   📅 ${date} ${storageEmoji}\n   🔗 ${file.url}`;
            }).join('\n\n');
            const keyboard = {
                inline_keyboard: [
                    [{ text: "« 返回", callback_data: "back_to_panel" }]
                ]
            };
            if (config.buttonCache) {
                config.buttonCache.set(cacheKey, {
                    timestamp: Date.now(),
                    replyText: "📋 您最近上传的文件：\n\n" + filesList,
                    replyMarkup: keyboard,
                    disablePreview: true
                });
            }
            await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: "📋 您最近上传的文件：\n\n" + filesList,
                    reply_markup: keyboard,
                    disable_web_page_preview: true
                })
            });
        }
        else if (cbData === 'edit_suffix_input') {
            await answerPromise;
            await config.database.prepare('UPDATE user_settings SET waiting_for = ? WHERE chat_id = ?')
                .bind('edit_suffix_input_file', chatId).run();
            userSetting.waiting_for = 'edit_suffix_input_file';
            await sendMessage(chatId, "✏️ 请回复此消息，输入要修改后缀的文件完整名称（必须包含扩展名）或完整URL链接", config.tgBotToken);
        }
        else if (cbData === 'delete_file_input') {
            await answerPromise;
            await config.database.prepare('UPDATE user_settings SET waiting_for = ? WHERE chat_id = ?')
                .bind('delete_file_input', chatId).run();
            userSetting.waiting_for = 'delete_file_input';
            await sendMessage(chatId, "🗑️ 请回复此消息，输入要删除的文件完整名称（必须包含扩展名）或完整URL链接", config.tgBotToken);
        }
        else if (cbData.startsWith('delete_file_confirm_')) {
        }
        else if (cbData.startsWith('delete_file_do_')) {
        }
        else if (userSetting.waiting_for === 'edit_suffix_input_file' && update.message.text) {
            console.error('错误: 不应该执行到这里，修改后缀的逻辑已移至handleTelegramWebhook函数');
            try { await answerPromise; } catch { }
            return;
        }
        else if (userSetting.waiting_for === 'edit_suffix_input_new' && update.message.text && userSetting.editing_file_id) {
            console.error('错误: 不应该执行到这里，修改后缀的逻辑已移至handleTelegramWebhook函数');
            try { await answerPromise; } catch { }
            return;
        }
    } catch (error) {
        console.error('处理回调查询时出错:', error);
        try { await answerPromise; } catch { }
        await sendMessage(chatId, `❌ 处理请求时出错: ${error.message}`, config.tgBotToken);
    }
}
async function handleMediaUpload(chatId, file, isDocument, config, userSetting) {
    const processingMessage = await sendMessage(chatId, "⏳ 正在处理您的文件，请稍候...", config.tgBotToken);
    const processingMessageId = processingMessage && processingMessage.result ? processingMessage.result.message_id : null;
    try {
        console.log('原始文件信息:', JSON.stringify(file));
        const filePathPromise = fetch(`https://api.telegram.org/bot${config.tgBotToken}/getFile?file_id=${file.file_id}`)
            .then(response => response.json());
        let categoryId = null;
        let categoryPromise = null;
        if (userSetting && userSetting.current_category_id) {
            categoryId = userSetting.current_category_id;
        } else {
            categoryPromise = config.database.prepare('SELECT id FROM categories WHERE name = ?')
                .bind('默认分类').first()
                .then(async (defaultCategory) => {
                    if (!defaultCategory) {
                        try {
                            console.log('默认分类不存在，正在创建...');
                            const result = await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
                                .bind('默认分类', Date.now()).run();
                            const newDefaultId = result.meta && result.meta.last_row_id;
                            if (newDefaultId) {
                                return { id: newDefaultId };
                            }
                        } catch (error) {
                            console.error('创建默认分类失败:', error);
                        }
                    }
                    return defaultCategory;
                });
        }
        const data = await filePathPromise;
        if (!data.ok) throw new Error(`获取文件路径失败: ${JSON.stringify(data)}`);
        console.log('获取到文件路径:', data.result.file_path);
        const fileUrl = `https://api.telegram.org/file/bot${config.tgBotToken}/${data.result.file_path}`;
        const fileResponse = await fetch(fileUrl);
        if (!fileResponse.ok) throw new Error(`获取文件内容失败: ${fileResponse.status} ${fileResponse.statusText}`);
        const contentLength = fileResponse.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > config.maxSizeMB * 1024 * 1024) {
            if (processingMessageId) {
                await fetch(`https://api.telegram.org/bot${config.tgBotToken}/deleteMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: processingMessageId
                    })
                }).catch(err => console.error('删除处理消息失败:', err));
            }
            await sendMessage(chatId, `❌ 文件超过${config.maxSizeMB}MB限制`, config.tgBotToken);
            return;
        }
        fetch(`https://api.telegram.org/bot${config.tgBotToken}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: processingMessageId,
                text: "⏳ 文件已接收，正在上传到存储..."
            })
        }).catch(err => console.error('更新处理消息失败:', err));
        if (categoryPromise) {
            const defaultCategory = await categoryPromise;
            if (defaultCategory) {
                categoryId = defaultCategory.id;
            }
        }
        let fileName = '';
        let ext = '';
        let mimeType = file.mime_type || 'application/octet-stream';
        const filePathExt = data.result.file_path.split('.').pop().toLowerCase();
        if (file.file_name) {
            fileName = file.file_name;
            ext = (fileName.split('.').pop() || '').toLowerCase();
        }
        else if (filePathExt && filePathExt !== data.result.file_path.toLowerCase()) {
            ext = filePathExt;
        }
        else {
            ext = getExtensionFromMime(mimeType);
        }
        if (!fileName) {
            if (file.video_note) {
                fileName = `video_note_${Date.now()}.${ext}`;
            } else if (file.voice) {
                fileName = `voice_message_${Date.now()}.${ext}`;
            } else if (file.audio) {
                fileName = (file.audio.title || `audio_${Date.now()}`) + `.${ext}`;
            } else if (file.video) {
                fileName = `video_${Date.now()}.${ext}`;
            } else {
                fileName = `file_${Date.now()}.${ext}`;
            }
        }
        if (!mimeType || mimeType === 'application/octet-stream') {
            mimeType = getContentType(ext);
        }
        const mimeParts = mimeType.split('/');
        const mainType = mimeParts[0] || '';
        const subType = mimeParts[1] || '';
        console.log('处理文件:', JSON.stringify({
            fileName,
            ext,
            mimeType,
            mainType,
            subType,
            size: contentLength,
            filePath: data.result.file_path
        }));
        const storageType = userSetting && userSetting.storage_type ? userSetting.storage_type : 'r2';
        let finalUrl, dbFileId, dbMessageId;
        const timestamp = Date.now();
        const originalFileName = fileName.replace(/[^a-zA-Z0-9\-\_\.]/g, '_');
        const key = `${timestamp}_${originalFileName}`;
        if (storageType === 'r2' && config.bucket) {
            const arrayBuffer = await fileResponse.arrayBuffer();
            await config.bucket.put(key, arrayBuffer, {
                httpMetadata: { contentType: mimeType }
            });
            finalUrl = `https://${config.domain}/${key}`;
            dbFileId = key;
            dbMessageId = -1;
        } else {
            let method = 'sendDocument';
            let field = 'document';
            let messageId = null;
            let fileId = null;
            if (mainType === 'image' && !['svg+xml', 'x-icon'].includes(subType)) {
                method = 'sendPhoto';
                field = 'photo';
            } else if (mainType === 'video') {
                method = 'sendVideo';
                field = 'video';
            } else if (mainType === 'audio') {
                method = 'sendAudio';
                field = 'audio';
            } else {
                method = 'sendDocument';
                field = 'document';
            }
            console.log('Telegram上传方法:', { method, field });
            const arrayBuffer = await fileResponse.arrayBuffer();
            const tgFormData = new FormData();
            tgFormData.append('chat_id', config.tgStorageChatId);
            const blob = new Blob([arrayBuffer], { type: mimeType });
            tgFormData.append(field, blob, fileName);
            if (field !== 'photo') {
                tgFormData.append('caption', `File: ${fileName}\nType: ${mimeType}\nSize: ${formatSize(parseInt(contentLength || '0'))}`);
            }
            const tgResponse = await fetch(
                `https://api.telegram.org/bot${config.tgBotToken}/${method}`,
                { method: 'POST', body: tgFormData }
            );
            if (!tgResponse.ok) {
                const errorText = await tgResponse.text();
                console.error('Telegram API错误:', errorText);
                if (method !== 'sendDocument') {
                    console.log('尝试使用sendDocument方法重新上传');
                    const retryFormData = new FormData();
                    retryFormData.append('chat_id', config.tgStorageChatId);
                    retryFormData.append('document', blob, fileName);
                    retryFormData.append('caption', `File: ${fileName}\nType: ${mimeType}\nSize: ${formatSize(parseInt(contentLength || '0'))}`);
                    const retryResponse = await fetch(
                        `https://api.telegram.org/bot${config.tgBotToken}/sendDocument`,
                        { method: 'POST', body: retryFormData }
                    );
                    if (!retryResponse.ok) {
                        console.error('Telegram文档上传也失败:', await retryResponse.text());
                        throw new Error('Telegram文件上传失败');
                    }
                    const retryData = await retryResponse.json();
                    const retryResult = retryData.result;
                    messageId = retryResult.message_id;
                    fileId = retryResult.document?.file_id;
                    if (!fileId || !messageId) {
                        throw new Error('重试上传后仍未获取到有效的文件ID');
                    }
                } else {
                    throw new Error('Telegram参数配置错误: ' + errorText);
                }
            } else {
                const tgData = await tgResponse.json();
                const result = tgData.result;
                messageId = result.message_id;
                if (field === 'photo') {
                    const photos = result.photo;
                    fileId = photos[photos.length - 1]?.file_id;
                } else if (field === 'video') {
                    fileId = result.video?.file_id;
                } else if (field === 'audio') {
                    fileId = result.audio?.file_id;
                } else {
                    fileId = result.document?.file_id;
                }
            }
            if (!fileId) throw new Error('未获取到文件ID');
            if (!messageId) throw new Error('未获取到tg消息ID');
            finalUrl = `https://${config.domain}/${key}`;
            dbFileId = fileId;
            dbMessageId = messageId;
        }
        await fetch(`https://api.telegram.org/bot${config.tgBotToken}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: processingMessageId,
                text: "⏳ 正在写入数据库..."
            })
        }).catch(err => console.error('更新处理消息失败:', err));
        const time = Date.now();
        await config.database.prepare(`
      INSERT INTO files (
        url, 
        fileId, 
        message_id, 
        created_at, 
        file_name, 
        file_size, 
        mime_type, 
        chat_id, 
        category_id, 
        storage_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
            finalUrl,
            dbFileId,
            dbMessageId,
            time,
            fileName,
            contentLength,
            mimeType,
            chatId,
            categoryId,
            storageType
        ).run();
        if (processingMessageId) {
            await fetch(`https://api.telegram.org/bot${config.tgBotToken}/deleteMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    message_id: processingMessageId
                })
            }).catch(err => console.error('删除处理消息失败:', err));
        }
        const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(finalUrl)}`;
        await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                photo: qrCodeUrl,
                caption: `✅ 文件上传成功\n\n📝 图床直链：\n${finalUrl}\n\n🔍 扫描上方二维码快速访问`,
                parse_mode: 'HTML'
            })
        });
    } catch (error) {
        console.error("Error handling media upload:", error);
        if (processingMessageId) {
            await fetch(`https://api.telegram.org/bot${config.tgBotToken}/deleteMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    message_id: processingMessageId
                })
            }).catch(err => console.error('删除处理消息失败:', err));
        }
        await sendMessage(chatId, `❌ 上传失败: ${error.message}`, config.tgBotToken);
    }
}
async function getTelegramFileUrl(fileId, botToken, config) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
    const data = await response.json();
    if (!data.ok) throw new Error('获取文件路径失败');
    const filePath = data.result.file_path;
    const fileName = filePath.split('/').pop();
    const timestamp = Date.now();
    const fileExt = fileName.split('.').pop();
    const newFileName = `${timestamp}.${fileExt}`;
    if (config && config.domain) {
        return `https://${config.domain}/${newFileName}`;
    } else {
        return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    }
}
function authenticate(request, config) {
    if (!config.enableAuth) {
        console.log('[Auth] Authentication disabled.');
        return true;
    }
    if (!config.username || !config.password) {
        console.error("[Auth] FAILED: Missing USERNAME or PASSWORD configuration while auth is enabled.");
        return false;
    }
    const cookies = request.headers.get("Cookie") || "";
    const authToken = cookies.match(/auth_token=([^;]+)/);
    if (!authToken) {
        console.log('[Auth] FAILED: No auth_token cookie found.');
        return false;
    }
    try {
        const tokenData = JSON.parse(atob(authToken[1]));
        const now = Date.now();
        if (now > tokenData.expiration) {
            console.log("[Auth] FAILED: Token expired.");
            return false;
        }
        if (tokenData.username !== config.username) {
            console.log("[Auth] FAILED: Token username mismatch.");
            return false;
        }
        console.log('[Auth] SUCCESS: Valid token found.');
        return true;
    } catch (error) {
        console.error("[Auth] FAILED: Error validating token:", error);
        return false;
    }
}
async function handleAuthRequest(request, config) {
    if (config.enableAuth) {
        const isAuthenticated = authenticate(request, config);
        if (!isAuthenticated) {
            return handleLoginRequest(request, config);
        }
        return handleUploadRequest(request, config);
    }
    return handleUploadRequest(request, config);
}
async function handleLoginRequest(request, config) {
    if (request.method === 'POST') {
        let username, password;
        const contentType = request.headers.get("content-type") || "";

        if (contentType.includes("application/json")) {
            const body = await request.json();
            username = body.username;
            password = body.password;
        } else {
            const formData = await request.formData();
            username = formData.get("username");
            password = formData.get("password");
        }
        if (username === config.username && password === config.password) {
            const expirationDate = new Date();
            const cookieDays = config.cookie || 7;
            expirationDate.setDate(expirationDate.getDate() + cookieDays);
            const expirationTimestamp = expirationDate.getTime();
            const tokenData = JSON.stringify({
                username: config.username,
                expiration: expirationTimestamp
            });
            const token = btoa(tokenData);
            const cookie = `auth_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expirationDate.toUTCString()}`;
            return new Response("登录成功", {
                status: 200,
                headers: {
                    "Set-Cookie": cookie,
                    "Content-Type": "text/plain"
                }
            });
        }
        return new Response("认证失败", { status: 401 });
    }
    const html = generateLoginPage();
    return new Response(html, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
}
async function handleCreateCategoryRequest(request, config) {
    if (config.enableAuth && !authenticate(request, config)) {
        return new Response(JSON.stringify({ status: 0, msg: "未授权" }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    try {
        const { name } = await request.json();
        if (!name || typeof name !== 'string' || name.trim() === '') {
            return new Response(JSON.stringify({ status: 0, msg: "分类名称不能为空" }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        const categoryName = name.trim();
        const time = Date.now();
        const existingCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind(categoryName).first();
        if (existingCategory) {
            return new Response(JSON.stringify({ status: 0, msg: `分类 "${categoryName}" 已存在，请选择一个不同的名称！` }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
            .bind(categoryName, time).run();
        const category = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind(categoryName).first();
        return new Response(JSON.stringify({ status: 1, msg: "分类创建成功", category: { id: category.id, name: categoryName } }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ status: 0, msg: `创建分类失败：${error.message}` }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
async function handleDeleteCategoryRequest(request, config) {
    if (config.enableAuth && !authenticate(request, config)) {
        return new Response(JSON.stringify({ status: 0, msg: "未授权" }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    try {
        const { id } = await request.json();
        if (!id || isNaN(id)) {
            return new Response(JSON.stringify({ status: 0, msg: "分类ID无效" }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        const isDefaultCategory = await config.database.prepare('SELECT id FROM categories WHERE id = ? AND name = ?')
            .bind(id, '默认分类').first();
        if (isDefaultCategory) {
            return new Response(JSON.stringify({ status: 0, msg: "默认分类不能删除" }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        const category = await config.database.prepare('SELECT name FROM categories WHERE id = ?').bind(id).first();
        if (!category) {
            return new Response(JSON.stringify({ status: 0, msg: "分类不存在" }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        const defaultCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?')
            .bind('默认分类').first();
        let defaultCategoryId;
        if (!defaultCategory) {
            const result = await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
                .bind('默认分类', Date.now()).run();
            defaultCategoryId = result.meta && result.meta.last_row_id ? result.meta.last_row_id : null;
            console.log('创建了新的默认分类，ID:', defaultCategoryId);
        } else {
            defaultCategoryId = defaultCategory.id;
        }
        if (defaultCategoryId) {
            await config.database.prepare('UPDATE files SET category_id = ? WHERE category_id = ?')
                .bind(defaultCategoryId, id).run();
            await config.database.prepare('UPDATE user_settings SET current_category_id = ? WHERE current_category_id = ?')
                .bind(defaultCategoryId, id).run();
        } else {
            await config.database.prepare('UPDATE files SET category_id = NULL WHERE category_id = ?').bind(id).run();
            await config.database.prepare('UPDATE user_settings SET current_category_id = NULL WHERE current_category_id = ?').bind(id).run();
        }
        await config.database.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
        return new Response(JSON.stringify({
            status: 1,
            msg: `分类 "${category.name}" 删除成功${defaultCategoryId ? '，相关文件已移至默认分类' : ''}`
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('删除分类失败:', error);
        return new Response(JSON.stringify({ status: 0, msg: `删除分类失败：${error.message}` }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
async function handleUploadRequest(request, config) {
    if (config.enableAuth && !authenticate(request, config)) {
        return Response.redirect(`${new URL(request.url).origin}/`, 302);
    }
    if (request.method === 'GET') {
        const categories = await config.database.prepare('SELECT id, name FROM categories').all();
        const categoryOptions = categories.results.length
            ? categories.results.map(c => `<option value="${c.id}">${c.name}</option>`).join('')
            : '<option value="">暂无分类</option>';
        const chatId = config.tgChatId[0];
        let userSetting = await config.database.prepare('SELECT * FROM user_settings WHERE chat_id = ?').bind(chatId).first();
        if (!userSetting) {
            const defaultCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind('默认分类').first();
            await config.database.prepare('INSERT INTO user_settings (chat_id, storage_type, current_category_id) VALUES (?, ?, ?)')
                .bind(chatId, 'telegram', defaultCategory.id).run();
            userSetting = { storage_type: 'telegram', current_category_id: defaultCategory.id };
        }
        const html = generateUploadPage(categoryOptions, userSetting.storage_type);
        return new Response(html, {
            headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
    }
    try {
        const formData = await request.formData();
        const file = formData.get('file');
        const categoryId = formData.get('category');
        const storageType = formData.get('storage_type');
        if (!file) throw new Error('未找到文件');
        if (file.size > config.maxSizeMB * 1024 * 1024) throw new Error(`文件超过${config.maxSizeMB}MB限制`);
        const chatId = config.tgChatId[0];
        let defaultCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind('默认分类').first();
        if (!defaultCategory) {
            try {
                console.log('默认分类不存在，正在创建...');
                const result = await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
                    .bind('默认分类', Date.now()).run();
                const newDefaultId = result.meta && result.meta.last_row_id;
                if (newDefaultId) {
                    defaultCategory = { id: newDefaultId };
                    console.log(`已创建新的默认分类，ID: ${newDefaultId}`);
                }
            } catch (error) {
                console.error('创建默认分类失败:', error);
                defaultCategory = { id: categoryId || null };
            }
        }
        const finalCategoryId = categoryId || (defaultCategory ? defaultCategory.id : null);
        await config.database.prepare('UPDATE user_settings SET storage_type = ?, current_category_id = ? WHERE chat_id = ?')
            .bind(storageType, finalCategoryId, chatId).run();
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const mimeType = getContentType(ext);
        const [mainType] = mimeType.split('/');
        const typeMap = {
            image: { method: 'sendPhoto', field: 'photo' },
            video: { method: 'sendVideo', field: 'video' },
            audio: { method: 'sendAudio', field: 'audio' }
        };
        let { method = 'sendDocument', field = 'document' } = typeMap[mainType] || {};
        if (['application', 'text'].includes(mainType)) {
            method = 'sendDocument';
            field = 'document';
        }
        let finalUrl, dbFileId, dbMessageId;
        if (storageType === 'r2') {
            const key = `${Date.now()}.${ext}`;
            await config.bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: mimeType } });
            finalUrl = `https://${config.domain}/${key}`;
            dbFileId = key;
            dbMessageId = -1;
        } else {
            const tgFormData = new FormData();
            tgFormData.append('chat_id', config.tgStorageChatId);
            tgFormData.append(field, file, file.name);
            const tgResponse = await fetch(
                `https://api.telegram.org/bot${config.tgBotToken}/${method}`,
                { method: 'POST', body: tgFormData }
            );
            if (!tgResponse.ok) throw new Error('Telegram参数配置错误');
            const tgData = await tgResponse.json();
            const result = tgData.result;
            const messageId = result.message_id;
            const fileId = result.document?.file_id ||
                result.video?.file_id ||
                result.audio?.file_id ||
                (result.photo && result.photo[result.photo.length - 1]?.file_id);
            if (!fileId) throw new Error('未获取到文件ID');
            if (!messageId) throw new Error('未获取到tg消息ID');
            finalUrl = `https://${config.domain}/${Date.now()}.${ext}`;
            dbFileId = fileId;
            dbMessageId = messageId;
        }
        const time = Date.now();
        const timestamp = new Date(time + 8 * 60 * 60 * 1000).toISOString();
        const url = `https://${config.domain}/${time}.${ext}`;
        await config.database.prepare(`
      INSERT INTO files (url, fileId, message_id, created_at, file_name, file_size, mime_type, storage_type, category_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
            url,
            dbFileId,
            dbMessageId,
            timestamp,
            file.name,
            file.size,
            file.type || getContentType(ext),
            storageType,
            finalCategoryId
        ).run();
        return new Response(
            JSON.stringify({ status: 1, msg: "✔ 上传成功", url }),
            { headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error(`[Upload Error] ${error.message}`);
        let statusCode = 500;
        if (error.message.includes(`文件超过${config.maxSizeMB}MB限制`)) {
            statusCode = 400;
        } else if (error.message.includes('Telegram参数配置错误')) {
            statusCode = 502;
        } else if (error.message.includes('未获取到文件ID') || error.message.includes('未获取到tg消息ID')) {
            statusCode = 500;
        } else if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
            statusCode = 504;
        }
        return new Response(
            JSON.stringify({ status: 0, msg: "✘ 上传失败", error: error.message }),
            { status: statusCode, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
async function handleDeleteMultipleRequest(request, config) {
    if (config.enableAuth && !authenticate(request, config)) {
        return Response.redirect(`${new URL(request.url).origin}/`, 302);
    }
    try {
        const { urls } = await request.json();
        if (!Array.isArray(urls) || urls.length === 0) {
            return new Response(JSON.stringify({
                status: 0,
                error: '无效的URL列表'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        const results = {
            success: [],
            failed: []
        };
        for (const url of urls) {
            try {
                const fileName = url.split('/').pop();
                let file = await config.database.prepare(
                    'SELECT id, fileId, message_id, storage_type FROM files WHERE url = ?'
                ).bind(url).first();
                if (!file && fileName) {
                    file = await config.database.prepare(
                        'SELECT id, fileId, message_id, storage_type FROM files WHERE fileId = ?'
                    ).bind(fileName).first();
                }
                if (file) {
                    console.log(`正在删除文件: ${url}, 存储类型: ${file.storage_type}`);
                    if (file.storage_type === 'telegram' && file.message_id) {
                        try {
                            await fetch(
                                `https://api.telegram.org/bot${config.tgBotToken}/deleteMessage?chat_id=${config.tgStorageChatId}&message_id=${file.message_id}`
                            );
                            console.log(`已从Telegram删除消息: ${file.message_id}`);
                        } catch (error) {
                            console.error(`从Telegram删除消息失败: ${error.message}`);
                        }
                    } else if (file.storage_type === 'r2' && file.fileId && config.bucket) {
                        try {
                            await config.bucket.delete(file.fileId);
                            console.log(`已从R2删除文件: ${file.fileId}`);
                        } catch (error) {
                            console.error(`从R2删除文件失败: ${error.message}`);
                        }
                    }
                    await config.database.prepare('DELETE FROM files WHERE id = ?').bind(file.id).run();
                    console.log(`已从数据库删除记录: ID=${file.id}`);
                    results.success.push(url);
                } else {
                    console.log(`未找到文件记录: ${url}`);
                    results.failed.push({ url, reason: '未找到文件记录' });
                }
            } catch (error) {
                console.error(`删除文件失败 ${url}: ${error.message}`);
                results.failed.push({ url, reason: error.message });
            }
        }
        return new Response(
            JSON.stringify({
                status: 1,
                message: '批量删除处理完成',
                results: {
                    success: results.success.length,
                    failed: results.failed.length,
                    details: results
                }
            }),
            { headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error(`[Delete Multiple Error] ${error.message}`);
        return new Response(
            JSON.stringify({
                status: 0,
                error: error.message
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
async function handleAdminRequest(request, config) {
    if (config.enableAuth && !authenticate(request, config)) {
        return Response.redirect(`${new URL(request.url).origin}/`, 302);
    }
    try {
        const categories = await config.database.prepare('SELECT id, name FROM categories').all();
        const categoryOptions = categories.results.length
            ? categories.results.map(c => `<option value="${c.id}">${c.name}</option>`).join('')
            : '<option value="">暂无分类</option>';
        const files = await config.database.prepare(`
      SELECT f.url, f.fileId, f.message_id, f.created_at, f.file_name, f.file_size, f.mime_type, f.storage_type, c.name as category_name, c.id as category_id
      FROM files f
      LEFT JOIN categories c ON f.category_id = c.id
      ORDER BY f.created_at DESC
    `).all();
        const fileList = files.results || [];
        console.log(`文件总数: ${fileList.length}`);
        const fileCards = fileList.map(file => {
            const url = file.url;
            const uniqueId = `file-checkbox-${encodeURIComponent(url)}`;
            return `
          <div class="file-card" data-url="${url}" data-category-id="${file.category_id || ''}">
            <div class="checkbox-wrapper">
                <input type="checkbox" id="${uniqueId}" name="selectedFile" class="file-checkbox" value="${url}">
            </div>
            <div class="file-preview">
              ${getPreviewHtml(url)}
            </div>
            <div class="file-info">
              <div class="file-name" title="${getFileName(url)}">${getFileName(url)}</div>
              <div class="file-meta">
                  <span class="file-size">${formatSize(file.file_size || 0)}</span>
                  <span class="file-date">${formatDate(file.created_at).split(' ')[0]}</span>
              </div>
              <div class="file-category tag">${file.category_name || '无分类'}</div>
            </div>
            <div class="file-actions">
              <button class="btn btn-icon btn-share" title="分享" onclick="shareFile('${url}', '${getFileName(url)}')">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
              </button>
              <button class="btn btn-icon btn-edit" title="重命名" onclick="showEditSuffixModal('${url}')">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
              </button>
              <button class="btn btn-icon btn-delete" title="删除" onclick="showConfirmModal('确定要删除这个文件吗？', function() { deleteFile('${url}'); })">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
              </button>
            </div>
          </div>
        `;
        }).join('');
        const html = generateAdminPage(fileCards, categoryOptions);
        return new Response(html, {
            headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
    } catch (error) {
        console.error(`[Admin Error] ${error.message}`);
        return new Response(`加载文件列表失败，请检查数据库配置：${error.message}`, { status: 500 });
    }
}
async function handleSearchRequest(request, config) {
    if (config.enableAuth && !authenticate(request, config)) {
        return Response.redirect(`${new URL(request.url).origin}/`, 302);
    }
    try {
        const { query } = await request.json();
        const searchPattern = `%${query}%`;
        const files = await config.database.prepare(`
      SELECT url, fileId, message_id, created_at, file_name, file_size, mime_type
       FROM files 
       WHERE file_name LIKE ? ESCAPE '!'
       COLLATE NOCASE
       ORDER BY created_at DESC
    `).bind(searchPattern).all();
        return new Response(
            JSON.stringify({ files: files.results || [] }),
            { headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error(`[Search Error] ${error.message}`);
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}
function getPreviewHtml(url) {
    const ext = (url.split('.').pop() || '').toLowerCase();
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'icon'].includes(ext);
    const isVideo = ['mp4', 'webm'].includes(ext);
    const isAudio = ['mp3', 'wav', 'ogg'].includes(ext);
    if (isImage) {
        return `<img src="${url}" alt="预览">`;
    } else if (isVideo) {
        return `<video src="${url}" controls></video>`;
    } else if (isAudio) {
        return `<audio src="${url}" controls></audio>`;
    } else {
        return `<div style="font-size: 48px">📄</div>`;
    }
}
async function handleFileRequest(request, config) {
    try {
        const url = new URL(request.url);
        const path = decodeURIComponent(url.pathname.slice(1));
        if (!path) {
            return new Response('Not Found', { status: 404 });
        }
        const cacheKey = `file:${path}`;
        if (config.fileCache && config.fileCache.has(cacheKey)) {
            const cachedData = config.fileCache.get(cacheKey);
            if (Date.now() - cachedData.timestamp < config.fileCacheTTL) {
                console.log(`从缓存提供文件: ${path}`);
                return cachedData.response.clone();
            } else {
                config.fileCache.delete(cacheKey);
            }
        }
        const cacheAndReturnResponse = (response) => {
            if (config.fileCache) {
                config.fileCache.set(cacheKey, {
                    response: response.clone(),
                    timestamp: Date.now()
                });
            }
            return response;
        };
        const getCommonHeaders = (contentType) => {
            const headers = new Headers();
            headers.set('Content-Type', contentType);
            headers.set('Access-Control-Allow-Origin', '*');
            if (contentType.startsWith('image/') ||
                contentType.startsWith('video/') ||
                contentType.startsWith('audio/')) {
                headers.set('Content-Disposition', 'inline');
            }
            headers.set('Cache-Control', 'public, max-age=31536000');
            return headers;
        };
        if (config.bucket) {
            try {
                const object = await config.bucket.get(path);
                if (object) {
                    const contentType = object.httpMetadata.contentType || getContentType(path.split('.').pop());
                    const headers = getCommonHeaders(contentType);
                    object.writeHttpMetadata(headers);
                    headers.set('etag', object.httpEtag);
                    return cacheAndReturnResponse(new Response(object.body, { headers }));
                }
            } catch (error) {
                if (error.name !== 'NoSuchKey') {
                    console.error('R2获取文件错误:', error.name);
                }
            }
        }
        let file;
        const urlPattern = `https://${config.domain}/${path}`;
        file = await config.database.prepare('SELECT * FROM files WHERE url = ?').bind(urlPattern).first();
        if (!file) {
            file = await config.database.prepare('SELECT * FROM files WHERE fileId = ?').bind(path).first();
        }
        if (!file) {
            const fileName = path.split('/').pop();
            file = await config.database.prepare('SELECT * FROM files WHERE file_name = ?').bind(fileName).first();
        }
        if (!file) {
            return new Response('File not found', { status: 404 });
        }
        if (file.storage_type === 'telegram') {
            try {
                const telegramFileId = file.fileId;
                if (!telegramFileId) {
                    console.error('文件记录缺少Telegram fileId');
                    return new Response('Missing Telegram file ID', { status: 500 });
                }
                const response = await fetch(`https://api.telegram.org/bot${config.tgBotToken}/getFile?file_id=${telegramFileId}`);
                const data = await response.json();
                if (!data.ok) {
                    console.error('Telegram getFile 失败:', data.description);
                    return new Response('Failed to get file from Telegram', { status: 500 });
                }
                const telegramUrl = `https://api.telegram.org/file/bot${config.tgBotToken}/${data.result.file_path}`;
                const fileResponse = await fetch(telegramUrl);
                if (!fileResponse.ok) {
                    console.error(`从Telegram获取文件失败: ${fileResponse.status}`);
                    return new Response('Failed to fetch file from Telegram', { status: fileResponse.status });
                }
                const contentType = file.mime_type || getContentType(path.split('.').pop());
                const headers = getCommonHeaders(contentType);
                return cacheAndReturnResponse(new Response(fileResponse.body, { headers }));
            } catch (error) {
                console.error('处理Telegram文件出错:', error.message);
                return new Response('Error processing Telegram file', { status: 500 });
            }
        }
        else if (file.storage_type === 'r2' && config.bucket) {
            try {
                const object = await config.bucket.get(file.fileId);
                if (object) {
                    const contentType = object.httpMetadata.contentType || file.mime_type || getContentType(path.split('.').pop());
                    const headers = getCommonHeaders(contentType);
                    object.writeHttpMetadata(headers);
                    headers.set('etag', object.httpEtag);
                    return cacheAndReturnResponse(new Response(object.body, { headers }));
                }
            } catch (error) {
                console.error('通过fileId从R2获取文件出错:', error.message);
            }
        }
        if (file.url && file.url !== urlPattern) {
            return Response.redirect(file.url, 302);
        }
        return new Response('File not available', { status: 404 });
    } catch (error) {
        console.error('处理文件请求出错:', error.message);
        return new Response('Internal Server Error', { status: 500 });
    }
}
async function handleDeleteRequest(request, config) {
    if (config.enableAuth && !authenticate(request, config)) {
        return Response.redirect(`${new URL(request.url).origin}/`, 302);
    }
    try {
        const { id, fileId } = await request.json();
        if (!id && !fileId) {
            return new Response(JSON.stringify({
                status: 0,
                message: '缺少文件标识信息'
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }
        let file;
        if (id && id.startsWith('http')) {
            file = await config.database.prepare('SELECT * FROM files WHERE url = ?').bind(id).first();
        } else if (id) {
            file = await config.database.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
        }
        if (!file && fileId) {
            file = await config.database.prepare('SELECT * FROM files WHERE fileId = ?').bind(fileId).first();
        }
        if (!file) {
            return new Response(JSON.stringify({
                status: 0,
                message: '文件不存在'
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }
        console.log('准备删除文件:', {
            fileId: file.fileId,
            url: file.url,
            存储类型: file.storage_type
        });
        if (file.storage_type === 'r2' && config.bucket) {
            await deleteFile(file.fileId, config);
            console.log('已从R2存储中删除文件:', file.fileId);
        }
        await config.database.prepare('DELETE FROM files WHERE id = ?').bind(file.id).run();
        console.log('已从数据库中删除文件记录');
        return new Response(JSON.stringify({
            status: 1,
            message: '删除成功'
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('删除文件失败:', error);
        return new Response(JSON.stringify({
            status: 0,
            message: '删除文件失败: ' + error.message
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
function getContentType(ext) {
    const types = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        avif: 'image/avif',
        ico: 'image/x-icon',
        icon: 'image/x-icon',
        bmp: 'image/bmp',
        tiff: 'image/tiff',
        tif: 'image/tiff',
        mp4: 'video/mp4',
        webm: 'video/webm',
        ogg: 'video/ogg',
        ogv: 'video/ogg',
        avi: 'video/x-msvideo',
        mov: 'video/quicktime',
        wmv: 'video/x-ms-wmv',
        flv: 'video/x-flv',
        mkv: 'video/x-matroska',
        m4v: 'video/x-m4v',
        ts: 'video/mp2t',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        m4a: 'audio/mp4',
        aac: 'audio/aac',
        flac: 'audio/flac',
        wma: 'audio/x-ms-wma',
        pdf: 'application/pdf',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ppt: 'application/vnd.ms-powerpoint',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        rtf: 'application/rtf',
        txt: 'text/plain',
        md: 'text/markdown',
        csv: 'text/csv',
        html: 'text/html',
        htm: 'text/html',
        css: 'text/css',
        js: 'application/javascript',
        xml: 'application/xml',
        json: 'application/json',
        zip: 'application/zip',
        rar: 'application/x-rar-compressed',
        '7z': 'application/x-7z-compressed',
        tar: 'application/x-tar',
        gz: 'application/gzip',
        swf: 'application/x-shockwave-flash',
        ttf: 'font/ttf',
        otf: 'font/otf',
        woff: 'font/woff',
        woff2: 'font/woff2',
        eot: 'application/vnd.ms-fontobject',
        ini: 'text/plain',
        yml: 'application/yaml',
        yaml: 'application/yaml',
        toml: 'text/plain',
        py: 'text/x-python',
        java: 'text/x-java',
        c: 'text/x-c',
        cpp: 'text/x-c++',
        cs: 'text/x-csharp',
        php: 'application/x-php',
        rb: 'text/x-ruby',
        go: 'text/x-go',
        rs: 'text/x-rust',
        sh: 'application/x-sh',
        bat: 'application/x-bat',
        sql: 'application/sql'
    };
    const lowerExt = ext.toLowerCase();
    return types[lowerExt] || 'application/octet-stream';
}
async function handleBingImagesRequest(request, config) {
    const cache = caches.default;
    const cacheKey = new Request('https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=5');
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
        console.log('Returning cached response');
        return cachedResponse;
    }
    try {
        const res = await fetch(cacheKey);
        if (!res.ok) {
            console.error(`Bing API 请求失败，状态码：${res.status}`);
            return new Response('请求 Bing API 失败', { status: res.status });
        }
        const bingData = await res.json();
        const images = bingData.images.map(image => ({ url: `https://cn.bing.com${image.url}` }));
        const returnData = { status: true, message: "操作成功", data: images };
        const response = new Response(JSON.stringify(returnData), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=21600',
                'Access-Control-Allow-Origin': '*'
            }
        });
        await cache.put(cacheKey, response.clone());
        console.log('响应数据已缓存');
        return response;
    } catch (error) {
        console.error('请求 Bing API 过程中发生错误:', error);
        return new Response('请求 Bing API 失败', { status: 500 });
    }
}
function formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
}
function formatDate(timestamp) {
    if (!timestamp) return '未知时间';
    let date;
    try {
        let msTimestamp;
        if (typeof timestamp === 'number') {
            msTimestamp = timestamp > 9999999999 ? timestamp : timestamp * 1000;
        } else if (typeof timestamp === 'string') {
            date = new Date(timestamp);
            if (!isNaN(date.getTime())) {
                msTimestamp = date.getTime();
            } else {
                const numTimestamp = parseInt(timestamp);
                if (!isNaN(numTimestamp)) {
                    msTimestamp = numTimestamp > 9999999999 ? numTimestamp : numTimestamp * 1000;
                } else {
                    return '日期无效 (无法解析)';
                }
            }
        } else if (timestamp instanceof Date) {
            msTimestamp = timestamp.getTime();
        } else {
            return '日期无效 (类型错误)';
        }
        if (msTimestamp < 0 || msTimestamp > 8640000000000000) {
            return '日期无效 (范围超限)';
        }
        date = new Date(msTimestamp);
        if (isNaN(date.getTime())) {
            return '日期无效 (转换失败)';
        }
        const beijingTimeOffset = 8 * 60 * 60 * 1000;
        const beijingDate = new Date(date.getTime() + beijingTimeOffset);
        const year = beijingDate.getUTCFullYear();
        const month = (beijingDate.getUTCMonth() + 1).toString().padStart(2, '0');
        const day = beijingDate.getUTCDate().toString().padStart(2, '0');
        const hours = beijingDate.getUTCHours().toString().padStart(2, '0');
        const minutes = beijingDate.getUTCMinutes().toString().padStart(2, '0');
        const seconds = beijingDate.getUTCSeconds().toString().padStart(2, '0');
        return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
    } catch (error) {
        console.error("formatDate 错误:", error, "原始输入:", timestamp);
        return '日期格式化错误';
    }
}
async function sendMessage(chatId, text, botToken, replyToMessageId = null) {
    try {
        const requestBody = {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML'
        };
        if (replyToMessageId) {
            requestBody.reply_to_message_id = replyToMessageId;
        }
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });
        if (!response.ok) {
            const errorData = await response.text();
            console.error(`发送消息失败: HTTP ${response.status}, ${errorData}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error('发送消息错误:', error);
        return null;
    }
}
function generateLoginPage() {
    return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>☁️</text></svg>">
    <meta name="description" content="文件存储与分享平台">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 - 云存储</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
      :root {
        --primary-color: #818cf8;
        --secondary-color: #f472b6;
        --text-color: #f1f5f9;
        --text-secondary: #94a3b8;
        --glass-bg: rgba(39, 39, 42, 0.9);
        --glass-border: rgba(255, 255, 255, 0.08);
        --shadow-lg: 0 10px 40px -10px rgba(0,0,0,0.5);
      }
      body {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        margin: 0;
        padding: 0;
        min-height: 100vh;
        display: flex;
        justify-content: center;
        align-items: center;
        background-color: #18181b;
        color: var(--text-color);
        overflow: hidden;
      }
      /* 这里的背景图会被JS动态替换 */
      
      .container {
        max-width: 400px;
        width: 90%;
        background: var(--glass-bg);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid var(--glass-border);
        border-radius: 24px;
        box-shadow: var(--shadow-lg);
        padding: 2.5rem;
        position: relative;
        z-index: 10;
        transform: translateY(0);
        animation: floatUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes floatUp {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      
      .header {
        margin-bottom: 2rem;
        text-align: center;
      }
      h1 {
        color: var(--text-color);
        margin: 0 0 0.5rem 0;
        font-size: 2rem;
        font-weight: 700;
        letter-spacing: -0.025em;
      }
      .header p {
        color: var(--text-secondary);
        margin: 0;
        font-size: 0.95rem;
      }

      .form-group {
        margin-bottom: 1.5rem;
        position: relative;
      }
      .form-group label {
        display: block;
        margin-bottom: 0.5rem;
        color: var(--text-color);
        font-weight: 500;
        font-size: 0.9rem;
      }
      .form-group input {
        width: 100%;
        padding: 0.8rem 1rem;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        font-size: 1rem;
        background: rgba(0, 0, 0, 0.2);
        color: var(--text-color);
        transition: all 0.3s ease;
        box-sizing: border-box;
      }
      .form-group input:focus {
        outline: none;
        background: rgba(0, 0, 0, 0.4);
        border-color: var(--primary-color);
        box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.15);
      }
      /* Dark Mode Overrides */
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.3); }
      ::selection { background: rgba(99, 102, 241, 0.3); color: white; }
      input:-webkit-autofill,
      input:-webkit-autofill:hover, 
      input:-webkit-autofill:focus, 
      input:-webkit-autofill:active {
          -webkit-box-shadow: 0 0 0 30px #0f172a inset !important;
          -webkit-text-fill-color: white !important;
          transition: background-color 5000s ease-in-out 0s;
      }
      
      .btn-login {
        width: 100%;
        padding: 0.9rem;
        background: #eff3f4;
        color: #0f1419;
        border: none;
        border-radius: 9999px;
        font-size: 1rem;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.2s ease;
        box-shadow: 0 4px 12px rgba(255, 255, 255, 0.1);
      }
      .btn-login:hover {
        background: #d7dbdc;
        transform: translateY(-2px);
      }
      .btn-login:active {
        transform: translateY(0);
        background: #bfaaae;
      }

      .message {
        margin-top: 1.5rem;
        padding: 0.8rem;
        border-radius: 12px;
        font-size: 0.9rem;
        text-align: center;
        display: none;
        animation: fadeIn 0.3s ease;
      }
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-5px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .error-message {
        background: rgba(255, 59, 48, 0.1);
        color: #d32f2f;
        border: 1px solid rgba(255, 59, 48, 0.2);
      }
      .success-message {
        background: rgba(52, 199, 89, 0.1);
        color: #1b5e20;
        border: 1px solid rgba(52, 199, 89, 0.2);
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>欢迎回来</h1>
        <p>请登录以管理您的文件</p>
      </div>
      <form id="loginForm">
        <div class="form-group">
          <label for="username">账号</label>
          <input type="text" id="username" name="username" placeholder="请输入管理员账号" required>
        </div>
        <div class="form-group">
          <label for="password">密码</label>
          <input type="password" id="password" name="password" placeholder="请输入密码" required>
        </div>
        <button type="submit" class="btn-login" id="loginBtn">立即登录</button>
      </form>
      <div id="errorMessage" class="message error-message"></div>
      <div id="successMessage" class="message success-message"></div>
    </div>
    <script>
      const loginForm = document.getElementById('loginForm');
      const loginBtn = document.getElementById('loginBtn');
      const errorMessage = document.getElementById('errorMessage');
      const successMessage = document.getElementById('successMessage');

      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        // ... rest of login logic
        loginBtn.disabled = true;
        loginBtn.textContent = '登录中...';
        errorMessage.style.display = 'none';
        successMessage.style.display = 'none';
        
        const formData = new FormData(loginForm);
        const params = new URLSearchParams();
        for (const [key, value] of formData.entries()) {
          params.append(key, value);
        }

        try {
          const response = await fetch('/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params
          });
          
          if (response.redirected) {
             successMessage.textContent = '登录成功，正在跳转...';
             successMessage.style.display = 'block';
             setTimeout(() => {
                window.location.href = response.url;
             }, 500);
          } else {
             const data = await response.text();
             throw new Error('登录失败，请检查账号密码');
          }
        } catch (error) {
          errorMessage.textContent = error.message;
          errorMessage.style.display = 'block';
          loginBtn.disabled = false;
          loginBtn.textContent = '立即登录';
          
          // Shake animation
          loginForm.classList.add('shake');
          setTimeout(() => loginForm.classList.remove('shake'), 500);
        }
      });
    </script>
  </body>
  </html>`;
}
function generateUploadPage(categoryOptions, storageType) {
    return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>☁️</text></svg>">
    <meta name="description" content="Telegram文件存储与分享平台">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>文件上传 - 云存储</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
      :root {
        --primary-color: #818cf8;
        --secondary-color: #f472b6;
        --text-color: #f1f5f9;
        --text-secondary: #94a3b8;
        --glass-bg: rgba(39, 39, 42, 0.9);
        --glass-border: rgba(255, 255, 255, 0.08);
        --shadow-lg: 0 10px 40px -10px rgba(0,0,0,0.5);
        --success-color: #22c55e;
        --error-color: #ef4444;
      }
      body {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        margin: 0;
        padding: 20px;
        min-height: 100vh;
        background-color: #18181b;
        color: var(--text-color);
        display: flex;
        justify-content: center;
        align-items: center;
        box-sizing: border-box;
      }
      /* 动态背景逻辑保留，此处不再重复覆盖body背景 */

      .container {
        max-width: 900px;
        width: 100%;
        background: var(--glass-bg);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid var(--glass-border);
        border-radius: 24px;
        box-shadow: var(--shadow-lg);
        padding: 2.5rem;
        transition: transform 0.3s ease;
        animation: floatUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes floatUp {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 2rem;
        padding-bottom: 1rem;
        border-bottom: 1px solid rgba(0,0,0,0.05);
      }
      h1 {
        color: var(--text-color);
        margin: 0;
        font-size: 1.8rem;
        font-weight: 700;
        letter-spacing: -0.025em;
      }
      .admin-link {
        color: #eff3f4;
        text-decoration: none;
        font-size: 0.95rem;
        font-weight: 600;
        padding: 0.6rem 1.2rem;
        border-radius: 9999px;
        border: 1px solid rgba(255, 255, 255, 0.3);
        background: transparent;
        transition: all 0.2s ease;
      }
      .admin-link:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: #eff3f4;
        transform: translateY(-1px);
      }

      .options {
        display: flex;
        gap: 1rem;
        margin-bottom: 2rem;
        flex-wrap: wrap;
        align-items: stretch;
      }
      
      .category-select, .new-category input, .url-area textarea {
        padding: 0.8rem 1rem;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        font-size: 0.95rem;
        background: rgba(0, 0, 0, 0.2);
        color: var(--text-color);
        transition: all 0.3s ease;
        flex-grow: 1;
      }
      .category-select:focus, .new-category input:focus, .url-area textarea:focus {
        outline: none;
        border-color: var(--primary-color);
        background: rgba(0, 0, 0, 0.4);
        box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
      }
      .category-select option {
        background: #1e293b;
        color: var(--text-color);
      }
      /* Dark Mode Overrides */
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.3); }
      ::selection { background: rgba(99, 102, 241, 0.3); color: white; }
      input:-webkit-autofill,
      input:-webkit-autofill:hover, 
      input:-webkit-autofill:focus, 
      input:-webkit-autofill:active {
          -webkit-box-shadow: 0 0 0 30px #0f172a inset !important;
          -webkit-text-fill-color: white !important;
          transition: background-color 5000s ease-in-out 0s;
      }

      .new-category {
        display: flex;
        gap: 0.5rem;
        flex-grow: 1;
        min-width: 300px;
      }
      .new-category button {
        padding: 0.8rem 1.5rem;
        background: transparent;
        color: #eff3f4;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 9999px;
        cursor: pointer;
        font-weight: 600;
        white-space: nowrap;
        transition: all 0.2s ease;
      }
      .new-category button:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: #eff3f4;
        color: white;
        transform: translateY(-1px);
        box-shadow: none;
      }

      .storage-toggle {
        display: flex;
        background: rgba(0,0,0,0.05);
        padding: 4px;
        border-radius: 14px;
      }
      .storage-btn {
        padding: 0.6rem 1.2rem;
        border: none;
        border-radius: 9999px;
        background: transparent;
        color: var(--text-secondary);
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s ease;
      }
      .storage-btn.active {
        background: #eff3f4;
        color: #0f1419;
        box-shadow: 0 2px 8px rgba(255, 255, 255, 0.1);
      }
      .storage-btn:hover:not(.active) {
        color: #eff3f4;
        background: rgba(255, 255, 255, 0.05);
      }

      .upload-area {
        border: 2px dashed rgba(99, 102, 241, 0.3);
        padding: 3rem 2rem;
        text-align: center;
        margin-bottom: 2rem;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.02);
        transition: all 0.3s ease;
        cursor: pointer;
      }
      .upload-area:hover, .upload-area.dragover {
        border-color: var(--primary-color);
        background: rgba(99, 102, 241, 0.1);
        transform: scale(1.005);
      }
      .upload-area p {
        margin: 0;
        color: var(--text-secondary);
        font-size: 1.1rem;
        pointer-events: none;
      }

      .preview-area {
        margin-top: 1rem;
      }
      .preview-item {
        display: flex;
        align-items: center;
        padding: 1rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        margin-bottom: 0.8rem;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        transition: transform 0.2s ease;
      }
      .preview-item img {
        width: 48px;
        height: 48px;
        margin-right: 1rem;
        border-radius: 8px;
        object-fit: cover;
      }
      .preview-item .info {
        flex-grow: 1;
        color: var(--text-color);
        font-size: 0.95rem;
      }
      
      .progress-bar {
        height: 8px;
        background: rgba(0,0,0,0.05);
        border-radius: 4px;
        margin-top: 0.5rem;
        overflow: hidden;
        position: relative;
      }
      .progress-track {
        height: 100%;
        background: var(--primary-color);
        transition: width 0.3s ease;
        width: 0;
        border-radius: 4px;
        background-image: linear-gradient(45deg,rgba(255,255,255,.15) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.15) 50%,rgba(255,255,255,.15) 75%,transparent 75%,transparent);
        background-size: 1rem 1rem;
        animation: progress-stripe 1s linear infinite;
      }
      @keyframes progress-stripe {
        0% { background-position: 1rem 0; }
        100% { background-position: 0 0; }
      }
      .success .progress-track { background-color: var(--success-color); }
      .error .progress-track { background-color: var(--error-color); }

      .url-area {
        margin-top: 2rem;
      }
      .url-area textarea {
        width: 100%;
        min-height: 100px;
        padding: 1rem;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        /* Background handled by shared rule */
        font-family: monospace;
        font-size: 0.9rem;
        resize: vertical;
        transition: border-color 0.3s ease;
        box-sizing: border-box;
      }
      .url-area textarea:focus {
        outline: none;
        border-color: var(--primary-color);
        box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
      }

      .button-group {
        margin-top: 1.5rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .button-container {
        display: flex;
        gap: 0.8rem;
        flex-wrap: wrap;
      }
      .button-container button {
        padding: 0.7rem 1.5rem;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 9999px;
        background: transparent;
        color: #eff3f4;
        cursor: pointer;
        font-weight: 600;
        transition: all 0.2s ease;
        box-shadow: none;
      }
      .button-container button:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: #eff3f4;
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(255, 255, 255, 0.1);
      }

      .copyright {
        font-size: 0.85rem;
        color: var(--text-secondary);
      }
      .copyright a {
        color: var(--primary-color);
        text-decoration: none;
      }
      .copyright a:hover {
        text-decoration: underline;
      }

      /* Modal Enhancement */
      .modal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.6);
        backdrop-filter: blur(4px);
        z-index: 1000;
        justify-content: center;
        align-items: center;
        opacity: 0;
        transition: opacity 0.3s;
      }
      .modal.show {
        display: flex;
        opacity: 1;
      }
      .modal-content {
        background: var(--card-bg);
        padding: 2rem;
        border-radius: 20px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.5);
        border: 1px solid var(--glass-border);
        max-width: 400px;
        width: 90%;
        transform: scale(0.95);
        transition: transform 0.3s;
        text-align: center;
        color: var(--text-color);
      }
      .modal.show .modal-content {
        transform: scale(1);
      }
      .modal-title {
        margin: 0 0 1rem 0;
        font-size: 1.4rem;
        color: var(--text-color);
        font-weight: 700;
      }
      .modal-message {
        margin-bottom: 2rem;
        color: var(--text-secondary);
        line-height: 1.6;
        font-size: 1.05rem;
      }
      .modal-buttons {
        display: flex;
        gap: 1rem;
        justify-content: center;
      }
      .modal-button {
        padding: 0.8rem 2rem;
        border-radius: 9999px;
        border: none;
        cursor: pointer;
        font-weight: 700;
        transition: all 0.2s;
        font-size: 1rem;
      }
      .modal-confirm {
        background: #eff3f4;
        color: #0f1419;
        box-shadow: 0 4px 12px rgba(255, 255, 255, 0.1);
      }
      .modal-confirm:hover {
        background: #d7dbdc;
        transform: translateY(-2px);
      }
      .modal-cancel {
        background: transparent;
        color: #eff3f4;
        border: 1px solid rgba(255,255,255,0.3);
      }
      .modal-cancel:hover {
        background: rgba(255,255,255,0.1);
        border-color: #eff3f4;
      }
      
      @media (max-width: 768px) {
        .container {
          padding: 1.5rem;
          margin: 10px;
        }
        .header {
          flex-direction: column;
          align-items: flex-start;
          gap: 10px;
        }
        .options {
          flex-direction: column;
        }
        .new-category {
           width: 100%;
        }
        .button-group {
          flex-direction: column;
          align-items: stretch;
        }
        .button-container {
          justify-content: center;
        }
        .button-container button {
            flex-grow: 1;
        }
        .copyright {
            text-align: center;
        }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>文件上传</h1>
        <a href="/admin" class="admin-link">📂 管理文件</a>
      </div>
      <div class="options">
        <div style="flex-grow: 1; display: flex; gap: 1rem; flex-wrap: wrap;">
            <select id="categorySelect" class="category-select">
              <option value="">📁 选择分类</option>
              ${categoryOptions}
            </select>
            <div class="new-category">
              <input type="text" id="newCategoryInput" placeholder="输入新分类名称">
              <button onclick="createNewCategory()">＋ 新建</button>
            </div>
        </div>
        <div class="storage-toggle">
          <button class="storage-btn ${storageType === 'telegram' ? 'active' : ''}" data-storage="telegram">Telegram</button>
          <button class="storage-btn ${storageType === 'r2' ? 'active' : ''}" data-storage="r2">R2 Storage</button>
        </div>
      </div>
      <div class="upload-area" id="uploadArea">
        <div style="font-size: 3rem; margin-bottom: 1rem;">☁️</div>
        <p>点击选择 或 拖拽文件到此处</p>
        <p style="font-size: 0.85rem; margin-top: 0.5rem; opacity: 0.7;">支持多文件上传</p>
        <input type="file" id="fileInput" multiple style="display: none">
      </div>
      <div class="preview-area" id="previewArea"></div>
      <div class="url-area">
        <textarea id="urlArea" readonly placeholder="上传完成后的链接将显示在这里..."></textarea>
        <div class="button-group">
          <div class="button-container">
            <button onclick="copyUrls('url')">📋 复制 URL</button>
            <button onclick="copyUrls('markdown')">📝 复制 Markdown</button>
            <button onclick="copyUrls('html')">🌐 复制 HTML</button>
          </div>
          <div class="copyright">
            <span>© 2025 Powered by <a href="https://github.com/iawooo/cftc" target="_blank">CFTC</a></span>
          </div>
        </div>
      </div>
      <!-- 通用确认弹窗 -->
      <div id="confirmModal" class="modal">
        <div class="modal-content">
          <h3 class="modal-title">提示</h3>
          <p class="modal-message" id="confirmModalMessage"></p>
          <div class="modal-buttons">
            <button class="modal-button modal-confirm" id="confirmModalConfirm">确认</button>
            <button class="modal-button modal-cancel" id="confirmModalCancel">取消</button>
          </div>
        </div>
      </div>
    </div>
    <script>
      // Dark Mode: Background image disabled
      const uploadArea = document.getElementById('uploadArea');
      const fileInput = document.getElementById('fileInput');
      const previewArea = document.getElementById('previewArea');
      const urlArea = document.getElementById('urlArea');
      const categorySelect = document.getElementById('categorySelect');
      const newCategoryInput = document.getElementById('newCategoryInput');
      const storageButtons = document.querySelectorAll('.storage-btn');
      const confirmModal = document.getElementById('confirmModal');
      const confirmModalMessage = document.getElementById('confirmModalMessage');
      const confirmModalConfirm = document.getElementById('confirmModalConfirm');
      const confirmModalCancel = document.getElementById('confirmModalCancel');
      let uploadedUrls = [];
      let currentConfirmCallback = null;
      storageButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          storageButtons.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
      async function createNewCategory() {
        const categoryName = newCategoryInput.value.trim();
        if (!categoryName) {
          showConfirmModal('分类名称不能为空！', null, true);
          return;
        }
        try {
          const response = await fetch('/create-category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: categoryName })
          });
          const data = await response.json();
          if (data.status === 1) {
            const option = document.createElement('option');
            option.value = data.category.id;
            option.textContent = data.category.name;
            categorySelect.appendChild(option);
            categorySelect.value = data.category.id;
            newCategoryInput.value = '';
            showConfirmModal(data.msg, null, true);
          } else {
            showConfirmModal(data.msg, null, true);
          }
        } catch (error) {
          showConfirmModal('创建分类失败：' + error.message, null, true);
        }
      }
      function showConfirmModal(message, callback, alertOnly = false) {
        closeConfirmModal();
        confirmModalMessage.textContent = message;
        currentConfirmCallback = callback;
        if (alertOnly) {
          confirmModalConfirm.textContent = '确定';
          confirmModalCancel.style.display = 'none';
        } else {
          confirmModalConfirm.textContent = '确认';
          confirmModalCancel.style.display = 'inline-block';
        }
        confirmModal.classList.add('show');
      }
      function closeConfirmModal() {
        confirmModal.classList.remove('show');
      }
      confirmModalConfirm.addEventListener('click', () => {
        if (currentConfirmCallback) {
          currentConfirmCallback();
        }
        closeConfirmModal();
      });
      confirmModalCancel.addEventListener('click', closeConfirmModal);
      window.addEventListener('click', (event) => {
        if (confirmModal && event.target === confirmModal) {
          closeConfirmModal();
        }
      });
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
      });
      function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
      }
      ['dragenter', 'dragover'].forEach(eventName => {
        uploadArea.addEventListener(eventName, highlight, false);
      });
      ['dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, unhighlight, false);
      });
      function highlight(e) {
        uploadArea.classList.add('dragover');
      }
      function unhighlight(e) {
        uploadArea.classList.remove('dragover');
      }
      uploadArea.addEventListener('drop', handleDrop, false);
      uploadArea.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', handleFiles);
      function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFiles({ target: { files } });
      }
      document.addEventListener('paste', async (e) => {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (let item of items) {
          if (item.kind === 'file') {
            const file = item.getAsFile();
            await uploadFile(file);
          }
        }
      });
      async function handleFiles(e) {
        const response = await fetch('/config');
        if (!response.ok) {
          throw new Error('Failed to fetch config');
        }
        const config = await response.json();
        const files = Array.from(e.target.files);
        for (let file of files) {
          if (file.size > config.maxSizeMB * 1024 * 1024) {
            showConfirmModal(\`文件超过\${config.maxSizeMB}MB限制\`, null, true);
            return;
          }
          await uploadFile(file);
        }
      }
      async function uploadFile(file) {
        const preview = createPreview(file);
        previewArea.appendChild(preview);
        const xhr = new XMLHttpRequest();
        const progressTrack = preview.querySelector('.progress-track');
        const progressText = preview.querySelector('.progress-text');
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            progressTrack.style.width = \`\${percent}%\`;
            progressText.textContent = \`\${percent}%\`;
          }
        });
        xhr.addEventListener('load', () => {
          try {
            const data = JSON.parse(xhr.responseText);
            const progressText = preview.querySelector('.progress-text');
            if (xhr.status >= 200 && xhr.status < 300 && data.status === 1) {
              progressText.textContent = data.msg;
              uploadedUrls.push(data.url);
              updateUrlArea();
              preview.classList.add('success');
            } else {
              const errorMsg = [data.msg, data.error || '未知错误'].filter(Boolean).join(' | ');
              progressText.textContent = errorMsg;
              preview.classList.add('error');
            }
          } catch (e) {
            preview.querySelector('.progress-text').textContent = '✗ 响应解析失败';
            preview.classList.add('error');
          }
        });
        const formData = new FormData();
        formData.append('file', file);
        formData.append('category', categorySelect.value);
        formData.append('storage_type', document.querySelector('.storage-btn.active').dataset.storage);
        xhr.open('POST', '/upload');
        xhr.send(formData);
      }
      function createPreview(file) {
        const div = document.createElement('div');
        div.className = 'preview-item';
        if (file.type.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = URL.createObjectURL(file);
          div.appendChild(img);
        }
        const info = document.createElement('div');
        info.className = 'info';
        info.innerHTML = \`
          <div>\${file.name}</div>
          <div>\${formatSize(file.size)}</div>
          <div class="progress-bar">
            <div class="progress-track"></div>
            <span class="progress-text">0%</span>
          </div>
        \`;
        div.appendChild(info);
        return div;
      }
      function formatSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
          size /= 1024;
          unitIndex++;
        }
        return \`\${size.toFixed(2)} \${units[unitIndex]}\`;
      }
      function updateUrlArea() {
        urlArea.value = uploadedUrls.join('\\n');
      }
      function copyUrls(format) {
        let text = '';
        switch (format) {
          case 'url':
            text = uploadedUrls.join('\\n');
            break;
          case 'markdown':
            text = uploadedUrls.map(url => \`![](\${url})\`).join('\\n');
            break;
          case 'html':
            text = uploadedUrls.map(url => \`<img src="\${url}" />\`).join('\\n');
            break;
        }
        navigator.clipboard.writeText(text)
          .then(() => {
            showConfirmModal('已复制到剪贴板', null, true);
          })
          .catch(() => {
            showConfirmModal('复制失败，请手动复制', null, true);
          });
      }
    </script>
  </body>
  </html>`;
}
function generateAdminPage(fileCards, categoryOptions) {
    return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>☁️</text></svg>">
    <meta name="description" content="Telegram文件存储与分享平台">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>文件管理 - 云存储</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <!-- 确保QR码库在页面加载前就可用 -->
    <script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
    <style>
      :root {
        --primary-color: #818cf8;
        --secondary-color: #f472b6;
        --text-color: #f1f5f9;
        --text-secondary: #94a3b8;
        --glass-bg: rgba(39, 39, 42, 0.9);
        --glass-border: rgba(255, 255, 255, 0.08);
        --card-bg: #27272a;
        --shadow-lg: 0 10px 40px -10px rgba(0,0,0,0.5);
        --shadow-sm: 0 2px 5px rgba(0,0,0,0.2);
        --danger-color: #ef4444;
      }
      body {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        margin: 0;
        padding: 0;
        min-height: 100vh;
        background-color: #18181b;
        color: var(--text-color);
      }
      /* 动态背景逻辑保留 */

      .container {
        max-width: 1400px;
        margin: 0 auto;
        padding: 20px;
      }

      /* Header */
      .header {
        background: var(--glass-bg);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid var(--glass-border);
        padding: 1.2rem 1.5rem;
        border-radius: 20px;
        box-shadow: var(--shadow-lg);
        margin-bottom: 1.5rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 1rem;
      }
      .header h2 {
        margin: 0;
        font-size: 1.5rem;
        font-weight: 700;
        background: linear-gradient(135deg, var(--primary-color), var(--secondary-color));
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .header-controls {
        display: flex;
        gap: 0.8rem;
        align-items: center;
        flex-wrap: wrap;
      }
      
      .search-input, .filter-select {
        padding: 0.6rem 1rem;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        font-size: 0.9rem;
        background: rgba(0, 0, 0, 0.2);
        color: var(--text-color);
        transition: all 0.3s ease;
      }
      .search-input:focus, .filter-select:focus {
        outline: none;
        border-color: var(--primary-color);
        background: rgba(0, 0, 0, 0.4);
        box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
      }
      .filter-select option {
        background: #1e293b;
        color: var(--text-color);
      }
      /* Dark Mode Overrides */
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.3); }
      ::selection { background: rgba(99, 102, 241, 0.3); color: white; }
      
      .btn-primary {
        background: #eff3f4;
        color: #0f1419;
        padding: 0.7rem 1.5rem;
        border-radius: 9999px;
        text-decoration: none;
        font-size: 0.95rem;
        font-weight: 700;
        transition: all 0.2s ease;
        box-shadow: 0 4px 12px rgba(255, 255, 255, 0.1);
        border: none;
        cursor: pointer;
      }
      .btn-primary:hover {
        background: #d7dbdc;
        transform: translateY(-1px);
        box-shadow: 0 6px 16px rgba(255, 255, 255, 0.15);
      }

      /* Action Bar */
      .action-bar {
        background: var(--glass-bg);
        backdrop-filter: blur(12px);
        padding: 1rem 1.5rem;
        border-radius: 16px;
        box-shadow: var(--shadow-sm);
        margin-bottom: 2rem;
        display: flex;
        gap: 1.5rem;
        align-items: center;
        flex-wrap: wrap;
        border: 1px solid var(--glass-border);
      }
      .action-group {
        display: flex;
        gap: 0.8rem;
        align-items: center;
      }
      .action-label {
        font-weight: 600;
        font-size: 0.9rem;
        color: var(--text-secondary);
      }
      
      .btn-secondary {
        background: transparent;
        color: #eff3f4;
        border: 1px solid rgba(255,255,255,0.3);
        padding: 0.6rem 1.2rem;
        border-radius: 9999px;
        cursor: pointer;
        transition: all 0.2s;
        font-size: 0.9rem;
        font-weight: 600;
      }
      .btn-secondary:hover {
        border-color: #eff3f4;
        color: #fff;
        background: rgba(255,255,255,0.1);
      }
      .btn-danger {
        background: transparent;
        color: #fca5a5;
        border: 1px solid rgba(239, 68, 68, 0.5);
        padding: 0.6rem 1.2rem;
        border-radius: 9999px;
        cursor: pointer;
        transition: all 0.2s;
        font-size: 0.9rem;
        font-weight: 600;
      }
      .btn-danger:hover {
        background: rgba(239, 68, 68, 0.1);
        border-color: #ef4444;
        color: #ef4444;
      }

      /* Grid */
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 1.5rem;
        padding-bottom: 2rem;
      }
      
      .file-card {
        background: var(--card-bg);
        border-radius: 16px;
        overflow: hidden;
        position: relative;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        border: 1px solid rgba(255,255,255,0.5);
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
      }
      .file-card:hover {
        transform: translateY(-5px);
        box-shadow: 0 15px 30px rgba(0,0,0,0.08);
        border-color: rgba(99, 102, 241, 0.3);
      }
      .file-card.selected {
        border: 2px solid var(--primary-color);
        background: rgba(30, 41, 59, 0.95);
      }
      
      .checkbox-wrapper {
        position: absolute;
        top: 10px;
        left: 10px;
        z-index: 5;
      }
      .file-checkbox {
        width: 20px;
        height: 20px;
        cursor: pointer;
        accent-color: var(--primary-color);
      }

      .file-preview {
        height: 160px;
        background: rgba(0,0,0,0.02);
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }
      .file-preview img, .file-preview video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        transition: transform 0.5s ease;
      }
      .file-card:hover .file-preview img {
        transform: scale(1.05);
      }
      
      .file-info {
        padding: 1rem;
        flex-grow: 1;
      }
      .file-name {
        font-weight: 600;
        margin-bottom: 0.4rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--text-color);
      }
      .file-meta {
        display: flex;
        justify-content: space-between;
        font-size: 0.8rem;
        color: var(--text-secondary);
        margin-bottom: 0.5rem;
      }
      .tag {
        display: inline-block;
        padding: 2px 8px;
        background: rgba(99, 102, 241, 0.1);
        color: var(--primary-color);
        border-radius: 12px;
        font-size: 0.75rem;
        font-weight: 500;
      }
      
      .file-actions {
        padding: 0.8rem 1rem;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        justify-content: space-around;
        gap: 0.5rem;
        background: rgba(0, 0, 0, 0.2);
      }
      .btn-icon {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        border: none;
        cursor: pointer;
        background: transparent;
        color: var(--text-secondary);
        transition: all 0.2s;
      }
      .btn-icon:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #eff3f4;
        transform: scale(1.05);
      }
      .btn-delete:hover {
        color: #ef4444;
        background: rgba(239, 68, 68, 0.1);
      }

      /* Modals */
      .modal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.6);
        backdrop-filter: blur(4px);
        z-index: 1000;
        justify-content: center;
        align-items: center;
        opacity: 0;
        transition: opacity 0.3s;
      }
      .modal.show {
        display: flex;
        opacity: 1;
      }
      .modal-content {
        background: var(--card-bg);
        padding: 2rem;
        border-radius: 20px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.5);
        border: 1px solid var(--glass-border);
        max-width: 400px;
        width: 90%;
        transform: scale(0.95);
        transition: transform 0.3s;
      }
      .modal.show .modal-content {
        transform: scale(1);
      }
      .modal-title {
        margin: 0 0 1rem 0;
        font-size: 1.3rem;
        color: var(--text-color);
      }
      .modal-buttons {
        display: flex;
        gap: 1rem;
        justify-content: flex-end;
        margin-top: 1.5rem;
      }
      .modal-button {
        padding: 0.8rem 2rem;
        border-radius: 9999px;
        border: none;
        cursor: pointer;
        font-weight: 700;
        transition: all 0.2s;
      }
      .modal-confirm {
        background: #eff3f4;
        color: #0f1419;
      }
      .modal-confirm:hover { background: #d7dbdc; }
      .modal-cancel {
        background: transparent;
        border: 1px solid rgba(255,255,255,0.3);
        color: #eff3f4;
      }
      .modal-cancel:hover { background: rgba(255,255,255,0.1); border-color: #eff3f4; }
      
      #editSuffixInput {
          width: 100%;
          padding: 0.8rem;
          border: 2px solid #e2e8f0;
          border-radius: 8px;
          margin: 1rem 0;
          box-sizing: border-box;
      }

      /* QR Modal specific styles */
      #qrModal .modal-content {
        max-width: 350px;
        text-align: center;
      }
      .qr-file-name {
        color: var(--text-secondary);
        font-size: 0.9rem;
        margin-bottom: 1rem;
        word-break: break-all;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #qrcode-container {
        margin: 1.5rem auto;
        height: 200px;
        width: 200px;
        display: flex;
        justify-content: center;
        align-items: center;
      }
      #qrcode-container canvas {
        max-width: 100%;
        height: auto;
      }
      .qr-buttons {
        display: flex;
        gap: 0.8rem;
        justify-content: center;
        margin-top: 1.5rem;
        flex-wrap: wrap;
      }
      .qr-action-btn {
        padding: 0.6rem 1.2rem;
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.2s;
        font-size: 0.9rem;
        font-weight: 500;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: rgba(255,255,255,0.05);
        color: var(--text-color);
      }
      .qr-action-btn.primary {
        background: #eff3f4;
        border-color: #eff3f4;
        color: #0f1419;
        font-weight: 700;
      }
      .qr-action-btn:hover {
        transform: translateY(-1px);
        background: rgba(255,255,255,0.15);
      }
      .qr-action-btn.primary:hover {
        background: #d7dbdc;
        border-color: #d7dbdc;
      }


      @media (max-width: 768px) {
        .container { padding: 10px; }
        .header {
          flex-direction: column;
          align-items: stretch;
        }
        .header-controls {
          flex-direction: column;
          align-items: stretch;
        }
        .action-bar {
          flex-direction: column;
          align-items: stretch;
          padding: 1rem;
          gap: 1rem;
        }
        .action-group {
          justify-content: space-between;
        }
        .grid {
          grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
          gap: 10px;
        }
        .file-preview { height: 120px; }
        .file-actions { padding: 0.5rem; }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h2>文件管理</h2>
        <div class="header-controls">
          <input type="text" id="search-input" class="search-input" placeholder="🔍 搜索文件名...">
          <select id="category-filter" class="filter-select">
            <option value="">📂 所有分类</option>
            ${categoryOptions}
          </select>
          <a href="/upload" class="btn-primary">📤 上传文件</a>
        </div>
      </div>
      
      <div class="action-bar">
        <div class="action-group">
          <span class="action-label">批量操作:</span>
          <button class="btn-secondary" id="selectAllBtn">全选</button>
          <button class="btn-danger" id="deleteFilesBtn">删除选中</button>
        </div>
        <div class="action-group" style="flex-grow:1; justify-content: flex-end;">
          <span class="action-label">分类管理:</span>
          <select id="categoryDeleteSelect" class="filter-select" style="max-width: 150px;">
            <option value="">选择分类</option>
            ${categoryOptions}
          </select>
          <button class="btn-danger" id="deleteCategoryBtn">删除分类</button>
        </div>
      </div>

      <div class="grid" id="fileGrid">
        ${fileCards}
      </div>

      <!-- 确认删除弹窗 -->
      <div id="confirmModal" class="modal">
        <div class="modal-content">
          <h3 class="modal-title">请确认</h3>
          <p class="modal-message" id="confirmModalMessage">确认要执行此操作吗？</p>
          <div class="modal-buttons">
            <button class="modal-button modal-cancel" id="confirmModalCancel">取消</button>
            <button class="modal-button modal-confirm" id="confirmModalConfirm">确认</button>
          </div>
        </div>
      </div>

      <!-- 修改后缀弹窗 -->
      <div id="editSuffixModal" class="modal">
        <div class="modal-content">
          <h3 class="modal-title">修改文件后缀</h3>
          <input type="text" id="editSuffixInput" placeholder="输入新的格式 (如 jpg, mp4)">
          <div class="modal-buttons">
            <button class="modal-button modal-cancel" id="editSuffixCancel">取消</button>
            <button class="modal-button modal-confirm" id="editSuffixConfirm">保存修改</button>
          </div>
        </div>
      </div>
      
       <!-- 二维码/分享弹窗 -->
      <div id="qrModal" class="modal">
        <div class="modal-content">
          <h3 class="modal-title">分享文件</h3>
          <div class="qr-file-name" id="qrFileName"></div>
          <div id="qrcode-container"></div>
          <div class="qr-buttons">
            <button class="qr-copy" id="qrCopyBtn">复制链接</button>
            <a class="qr-download" id="qrDownloadBtn" download>下载文件</a>
            <button class="qr-close" id="qrCloseBtn">关闭</button>
          </div>
        </div>
      </div>

    </div>
    <script>
      let currentShareUrl = '';
      let currentConfirmCallback = null;
      let currentEditUrl = '';
      let confirmModal, confirmModalMessage, confirmModalConfirm, confirmModalCancel, editSuffixModal, qrModal, qrCopyBtn, qrDownloadBtn, qrCloseBtn, qrFileName, qrContainer;
      async function setBingBackground() {
          // Dark mode: Bing background disabled
      }
      // setTimeout(setBingBackground, 1000);
      document.addEventListener('DOMContentLoaded', function() {
        console.log('DOM已加载，初始化页面...');
        confirmModal = document.getElementById('confirmModal');
        confirmModalMessage = document.getElementById('confirmModalMessage');
        confirmModalConfirm = document.getElementById('confirmModalConfirm');
        confirmModalCancel = document.getElementById('confirmModalCancel');
        editSuffixModal = document.getElementById('editSuffixModal');
        qrModal = document.getElementById('qrModal');
        qrFileName = document.getElementById('qrFileName');
        qrContainer = document.getElementById('qrcode-container');
        qrCopyBtn = document.getElementById('qrCopyBtn');
        qrDownloadBtn = document.getElementById('qrDownloadBtn');
        qrCloseBtn = document.getElementById('qrCloseBtn');
        const searchInput = document.getElementById('search-input');
        const categoryFilter = document.getElementById('category-filter');
        const selectAllBtn = document.getElementById('selectAllBtn');
        const deleteFilesBtn = document.getElementById('deleteFilesBtn');
        const deleteCategoryBtn = document.getElementById('deleteCategoryBtn');
        const editSuffixConfirm = document.getElementById('editSuffixConfirm');
        const editSuffixCancel = document.getElementById('editSuffixCancel');
        console.log('页面元素引用:', {
          confirmModal: !!confirmModal,
          editSuffixModal: !!editSuffixModal,
          qrModal: !!qrModal
        });
        if (searchInput) searchInput.addEventListener('input', filterFiles);
        if (categoryFilter) categoryFilter.addEventListener('change', filterFiles);
        if (selectAllBtn) selectAllBtn.addEventListener('click', toggleSelectAll);
        if (deleteFilesBtn) deleteFilesBtn.addEventListener('click', confirmDeleteSelected);
        if (deleteCategoryBtn) deleteCategoryBtn.addEventListener('click', confirmDeleteCategory);
        if (confirmModalConfirm) confirmModalConfirm.addEventListener('click', handleConfirmModalConfirm);
        if (confirmModalCancel) confirmModalCancel.addEventListener('click', closeConfirmModal);
        if (editSuffixCancel) editSuffixCancel.addEventListener('click', function() {
          if (editSuffixModal) editSuffixModal.classList.remove('show');
        });
        if (editSuffixConfirm) editSuffixConfirm.addEventListener('click', updateFileSuffix);
        if (qrCopyBtn) qrCopyBtn.addEventListener('click', copyCurrentShareUrl);
        if (qrDownloadBtn) { }
        if (qrCloseBtn) qrCloseBtn.addEventListener('click', closeQrModal);
        window.addEventListener('click', handleWindowClick);
        initializeFileCards();
      });
      function initializeFileCards() {
        const fileGrid = document.getElementById('fileGrid');
        if (!fileGrid) return;
        const fileCards = Array.from(fileGrid.children);
        fileCards.forEach(card => {
          const checkbox = card.querySelector('.file-checkbox');
          if (!checkbox) return;
          card.addEventListener('click', (e) => {
            if (e.target === checkbox || 
                e.target.closest('.file-actions a') || 
                e.target.closest('.file-actions button')) {
              return; 
            }
            checkbox.checked = !checkbox.checked;
            const changeEvent = new Event('change', { bubbles: true });
            checkbox.dispatchEvent(changeEvent);
          });
          checkbox.addEventListener('change', () => {
            card.classList.toggle('selected', checkbox.checked);
          });
           card.classList.toggle('selected', checkbox.checked);
        });
      }
      function filterFiles() {
        const searchInput = document.getElementById('search-input');
        const categoryFilter = document.getElementById('category-filter');
        const fileGrid = document.getElementById('fileGrid');
        if (!searchInput || !categoryFilter || !fileGrid) return;
        const searchTerm = searchInput.value.toLowerCase();
        const selectedCategory = categoryFilter.value;
        const fileCards = Array.from(fileGrid.children);
        fileCards.forEach(card => {
          const fileInfo = card.querySelector('.file-info');
          if (!fileInfo) return;
          const fileName = fileInfo.querySelector('div:first-child')?.textContent.toLowerCase() || '';
          const categoryId = card.getAttribute('data-category-id') || '';
          const matchesSearch = fileName.includes(searchTerm);
          const matchesCategory = selectedCategory === '' || categoryId === selectedCategory;
          card.style.display = matchesSearch && matchesCategory ? '' : 'none';
        });
      }
      function toggleSelectAll() {
        const fileGrid = document.getElementById('fileGrid');
        if (!fileGrid) return;
        const fileCards = Array.from(fileGrid.children);
        const visibleCards = fileCards.filter(card => card.style.display !== 'none');
        const allSelected = visibleCards.every(card => card.querySelector('.file-checkbox')?.checked);
        visibleCards.forEach(card => {
          const checkbox = card.querySelector('.file-checkbox');
          if (checkbox) {
            checkbox.checked = !allSelected;
            card.classList.toggle('selected', !allSelected);
          }
        });
      }
      function confirmDeleteSelected() {
        const selectedCheckboxes = document.querySelectorAll('.file-checkbox:checked');
        if (selectedCheckboxes.length === 0) {
          showConfirmModal('请先选择要删除的文件！', null, true);
          return;
        }
        showConfirmModal(
          \`确定要删除选中的 \${selectedCheckboxes.length} 个文件吗？\`, 
          deleteSelectedFiles
        );
      }
      function confirmDeleteCategory() {
        const select = document.getElementById('categoryDeleteSelect');
        if (!select) return;
        const categoryId = select.value;
        if (!categoryId) {
          showConfirmModal('请选择要删除的分类', null, true);
          return;
        }
        const categoryName = select.options[select.selectedIndex].text;
        showConfirmModal(
          \`确定要删除分类 "\${categoryName}" 吗？这将清空所有关联文件的分类！\`, 
          deleteCategory
        );
      }
      function shareFile(url, fileName) {
        console.log('分享文件:', url);
        currentShareUrl = url;
        
        if (qrFileName) {
            qrFileName.textContent = fileName || getFileName(url);
        }
        
        if (qrContainer) {
            qrContainer.innerHTML = ''; // Clear previous QR
            try {
                new QRCode(qrContainer, {
                  text: url,
                  width: 200,
                  height: 200,
                  colorDark: "#000000",
                  colorLight: "#ffffff",
                  correctLevel: QRCode.CorrectLevel.H
                });
            } catch (qrError) {
                console.error('二维码生成失败:', qrError);
                qrContainer.textContent = url;
            }
        }
        
        if (qrDownloadBtn) {
            qrDownloadBtn.href = url;
            qrDownloadBtn.setAttribute('download', fileName || getFileName(url));
            qrDownloadBtn.className = 'qr-action-btn'; // Reset class
        }
        
        if (qrCopyBtn) {
            qrCopyBtn.textContent = '复制链接';
            qrCopyBtn.className = 'qr-action-btn primary';
        }
        
        if (qrCloseBtn) {
            qrCloseBtn.className = 'qr-action-btn';
        }

        if (qrModal) {
            qrModal.classList.add('show');
        }
      }
      function closeQrModal() {
        if (qrModal) qrModal.classList.remove('show');
      }
      function copyCurrentShareUrl() {
        if (!currentShareUrl) return;
        navigator.clipboard.writeText(currentShareUrl)
          .then(() => {
            if (qrCopyBtn) {
              qrCopyBtn.textContent = '✓ 已复制';
              setTimeout(() => {
                qrCopyBtn.textContent = '复制链接';
              }, 2000);
            }
          })
          .catch(() => {
            prompt('请手动复制链接:', currentShareUrl);
          });
      }
      function showConfirmModal(message, callback, alertOnly = false) {
        if (!confirmModal || !confirmModalMessage || !confirmModalConfirm || !confirmModalCancel) {
          alert(message);
          if (callback && !alertOnly) callback();
          return;
        }
        closeConfirmModal();
        confirmModalMessage.textContent = message;
        currentConfirmCallback = callback;
        if (alertOnly) {
          confirmModalConfirm.textContent = '确定';
          confirmModalCancel.style.display = 'none';
        } else {
          confirmModalConfirm.textContent = '确认';
          confirmModalCancel.style.display = 'inline-block';
        }
        confirmModal.classList.add('show');
      }
      function closeConfirmModal() {
        if (confirmModal) confirmModal.classList.remove('show');
      }
      function handleConfirmModalConfirm() {
        if (currentConfirmCallback) {
          currentConfirmCallback();
        }
        closeConfirmModal();
      }
      function handleWindowClick(event) {
        if (confirmModal && event.target === confirmModal) {
          closeConfirmModal();
        }
        if (qrModal && event.target === qrModal) { 
          closeQrModal();
        }
        if (editSuffixModal && event.target === editSuffixModal) {
          editSuffixModal.classList.remove('show');
        }
      }
      function showEditSuffixModal(url) {
        console.log('显示修改后缀弹窗:', url, '弹窗元素:', !!editSuffixModal);
        if (!editSuffixModal) {
          console.error('修改后缀弹窗元素不存在');
          alert('修改后缀功能不可用');
          return;
        }
        currentEditUrl = url;
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        const fileName = pathParts[pathParts.length - 1];
        const fileNameParts = fileName.split('.');
        const extension = fileNameParts.pop(); 
        const currentSuffix = fileNameParts.join('.'); 
        const editSuffixInput = document.getElementById('editSuffixInput');
        if (editSuffixInput) {
          editSuffixInput.value = currentSuffix;
          editSuffixModal.classList.add('show');
        } else {
          console.error('找不到编辑后缀输入框');
        }
      }
      async function deleteFile(url, card) {
        try {
          const urlObj = new URL(url);
          const pathParts = urlObj.pathname.split('/');
          const fileName = pathParts[pathParts.length - 1];
          const response = await fetch('/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: url, fileId: fileName }) 
          });
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || errorData.message || '删除失败');
          }
          if (card) {
            card.remove();
          } else {
            const card = document.querySelector(\`[data-url="\${url}"]\`);
            if (card) card.remove();
          }
          showConfirmModal('文件删除成功', null, true);
        } catch (error) {
          showConfirmModal('文件删除失败: ' + error.message, null, true);
        }
      }
      async function deleteSelectedFiles() {
        const checkboxes = document.querySelectorAll('.file-checkbox:checked');
        const urls = Array.from(checkboxes).map(cb => cb.value);
        try {
          const response = await fetch('/delete-multiple', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls })
          });
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '批量删除失败');
          }
          checkboxes.forEach(cb => {
            const card = cb.closest('.file-card');
            if (card) card.remove();
          });
          showConfirmModal('批量删除成功', null, true);
        } catch (error) {
          showConfirmModal('批量删除失败: ' + error.message, null, true);
        }
      }
      async function deleteCategory() {
        const select = document.getElementById('categoryDeleteSelect');
        if (!select) return;
        const categoryId = select.value;
        try {
          const response = await fetch('/delete-category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: categoryId })
          });
          const data = await response.json();
          if (data.status === 1) {
            select.remove(select.selectedIndex);
            showConfirmModal(data.msg, () => {
              window.location.reload();
            }, true);
          } else {
            showConfirmModal(data.msg, null, true);
          }
        } catch (error) {
          showConfirmModal('删除分类失败: ' + error.message, null, true);
        }
      }
      async function updateFileSuffix() {
        const editSuffixInput = document.getElementById('editSuffixInput');
        if (!editSuffixInput) return;
        const newSuffix = editSuffixInput.value;
        try {
          const response = await fetch('/update-suffix', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              url: currentEditUrl,
              suffix: newSuffix
            })
          });
          const data = await response.json();
          if (data.status === 1) {
            if (editSuffixModal) editSuffixModal.classList.remove('show');
            const card = document.querySelector('.file-card[data-url="' + currentEditUrl + '"]');
            if (card) {
              card.setAttribute('data-url', data.newUrl);
              const shareBtn = card.querySelector('.btn-share');
              const deleteBtn = card.querySelector('.btn-delete');
              const editBtn = card.querySelector('.btn-edit');
              if (shareBtn) {
                const fileName = getFileName(data.newUrl);
                shareBtn.setAttribute('onclick', 'shareFile("' + data.newUrl + '", "' + fileName + '")');
              }
              if (deleteBtn) {
                const newOnclick = deleteBtn.getAttribute('onclick').replace(currentEditUrl, data.newUrl);
                deleteBtn.setAttribute('onclick', newOnclick);
              }
              if (editBtn) {
                editBtn.setAttribute('onclick', 'showEditSuffixModal("' + data.newUrl + '")');
              }
              const fileNameElement = card.querySelector('.file-info div:first-child');
              if (fileNameElement) {
                const urlObj = new URL(data.newUrl);
                const fileName = urlObj.pathname.split('/').pop();
                fileNameElement.textContent = fileName;
              }
              const checkbox = card.querySelector('.file-checkbox');
              if (checkbox) {
                checkbox.value = data.newUrl;
              }
            }
            currentEditUrl = data.newUrl;
            showConfirmModal(data.msg, null, true);
          } else {
            showConfirmModal(data.msg || '修改后缀失败', null, true);
          }
        } catch (error) {
          showConfirmModal('修改后缀时出错：' + error.message, null, true);
        }
      }
      function getFileName(url) {
        try {
          const urlObj = new URL(url);
          const pathParts = urlObj.pathname.split('/');
          return pathParts[pathParts.length - 1];
        } catch (e) {
          return url.split('/').pop() || url;
        }
      }
    </script>
  </body>
  </html>`;
}
async function handleUpdateSuffixRequest(request, config) {
    try {
        const { url, suffix } = await request.json();
        if (!url || !suffix) {
            return new Response(JSON.stringify({
                status: 0,
                msg: '文件链接和后缀不能为空'
            }), { headers: { 'Content-Type': 'application/json' } });
        }
        const originalFileName = getFileName(url);
        let fileRecord = await config.database.prepare('SELECT * FROM files WHERE url = ?')
            .bind(url).first();
        if (!fileRecord) {
            fileRecord = await config.database.prepare('SELECT * FROM files WHERE fileId = ?')
                .bind(originalFileName).first();
            if (!fileRecord) {
                return new Response(JSON.stringify({
                    status: 0,
                    msg: '未找到对应的文件记录'
                }), { headers: { 'Content-Type': 'application/json' } });
            }
        }
        const fileExt = originalFileName.split('.').pop();
        const newFileName = `${suffix}.${fileExt}`;
        let fileUrl = `https://${config.domain}/${newFileName}`;
        const existingFile = await config.database.prepare('SELECT * FROM files WHERE fileId = ? AND id != ?')
            .bind(newFileName, fileRecord.id).first();
        if (existingFile) {
            return new Response(JSON.stringify({
                status: 0,
                msg: '后缀已存在，无法修改'
            }), { headers: { 'Content-Type': 'application/json' } });
        }
        const existingUrl = await config.database.prepare('SELECT * FROM files WHERE url = ? AND id != ?')
            .bind(fileUrl, fileRecord.id).first();
        if (existingUrl) {
            return new Response(JSON.stringify({
                status: 0,
                msg: '该URL已被使用，请尝试其他后缀'
            }), { headers: { 'Content-Type': 'application/json' } });
        }
        console.log('准备更新文件:', {
            记录ID: fileRecord.id,
            原URL: fileRecord.url,
            原fileId: fileRecord.fileId,
            存储类型: fileRecord.storage_type,
            新文件名: newFileName,
            新URL: fileUrl
        });
        if (fileRecord.storage_type === 'telegram') {
            await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                .bind(fileUrl, fileRecord.id).run();
            console.log('Telegram文件更新完成:', {
                id: fileRecord.id,
                新URL: fileUrl
            });
        }
        else if (config.bucket) {
            try {
                const fileId = fileRecord.fileId || originalFileName;
                console.log('尝试从R2获取文件:', fileId);
                const file = await config.bucket.get(fileId);
                if (file) {
                    console.log('R2文件存在，正在复制到新名称:', newFileName);
                    const fileData = await file.arrayBuffer();
                    await storeFile(fileData, newFileName, file.httpMetadata.contentType, config);
                    await deleteFile(fileId, config);
                    await config.database.prepare('UPDATE files SET fileId = ?, url = ? WHERE id = ?')
                        .bind(newFileName, fileUrl, fileRecord.id).run();
                    console.log('R2文件更新完成:', {
                        id: fileRecord.id,
                        新fileId: newFileName,
                        新URL: fileUrl
                    });
                } else {
                    console.log('R2中未找到文件，只更新URL:', fileId);
                    await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                        .bind(fileUrl, fileRecord.id).run();
                }
            } catch (error) {
                console.error('处理R2文件重命名失败:', error);
                await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                    .bind(fileUrl, fileRecord.id).run();
            }
        }
        else {
            console.log('未知存储类型，只更新URL');
            await config.database.prepare('UPDATE files SET url = ? WHERE id = ?')
                .bind(fileUrl, fileRecord.id).run();
        }
        return new Response(JSON.stringify({
            status: 1,
            msg: '后缀修改成功',
            newUrl: fileUrl
        }), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
        console.error('更新后缀失败:', error);
        return new Response(JSON.stringify({
            status: 0,
            msg: '更新后缀失败: ' + error.message
        }), { headers: { 'Content-Type': 'application/json' } });
    }
}
function generateNewUrl(url, suffix, config) {
    const fileName = getFileName(url);
    const newFileName = suffix + '.' + fileName.split('.').pop();
    return `https://${config.domain}/${newFileName}`;
}
function getFileName(url) {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    return pathParts[pathParts.length - 1];
}
function copyToClipboard(text) {
    navigator.clipboard.writeText(text)
        .then(() => {
            showConfirmModal('已复制到剪贴板', null, true);
        })
        .catch(() => {
            showConfirmModal('复制失败，请手动复制', null, true);
        });
}
function getExtensionFromMime(mimeType) {
    if (!mimeType) return 'jpg';
    const mimeMap = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
        'image/bmp': 'bmp',
        'image/avif': 'avif',
        'image/tiff': 'tiff',
        'image/x-icon': 'ico',
        'video/mp4': 'mp4',
        'video/webm': 'webm',
        'video/ogg': 'ogv',
        'video/x-msvideo': 'avi',
        'video/quicktime': 'mov',
        'video/x-ms-wmv': 'wmv',
        'video/x-flv': 'flv',
        'video/x-matroska': 'mkv',
        'video/x-m4v': 'm4v',
        'video/mp2t': 'ts',
        'audio/mpeg': 'mp3',
        'audio/mp3': 'mp3',
        'audio/ogg': 'ogg',
        'audio/wav': 'wav',
        'audio/mp4': 'm4a',
        'audio/aac': 'aac',
        'audio/flac': 'flac',
        'audio/x-ms-wma': 'wma',
        'application/pdf': 'pdf',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-excel': 'xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/vnd.ms-powerpoint': 'ppt',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
        'application/rtf': 'rtf',
        'application/zip': 'zip',
        'application/x-rar-compressed': 'rar',
        'application/x-7z-compressed': '7z',
        'application/x-tar': 'tar',
        'application/gzip': 'gz',
        'text/plain': 'txt',
        'text/markdown': 'md',
        'text/csv': 'csv',
        'text/html': 'html',
        'text/css': 'css',
        'text/javascript': 'js',
        'application/javascript': 'js',
        'application/json': 'json',
        'application/xml': 'xml',
        'font/ttf': 'ttf',
        'font/otf': 'otf',
        'font/woff': 'woff',
        'font/woff2': 'woff2',
        'application/vnd.ms-fontobject': 'eot',
        'application/octet-stream': 'bin',
        'application/x-shockwave-flash': 'swf'
    };
    return mimeMap[mimeType] || 'bin';
}
async function uploadToR2(arrayBuffer, fileName, mimeType, config) {
    try {
        return await storeFile(arrayBuffer, fileName, mimeType, config);
    } catch (error) {
        console.error('上传到R2失败:', error);
        throw new Error(`上传到存储服务失败: ${error.message}`);
    }
}
async function storeFile(arrayBuffer, fileName, mimeType, config) {
    if (config.bucket) {
        try {
            await config.bucket.put(fileName, arrayBuffer, {
                httpMetadata: { contentType: mimeType || 'application/octet-stream' }
            });
            return `https://${config.domain}/${fileName}`;
        } catch (error) {
            console.error(`R2存储失败: ${error.message}`);
            return await storeFileInTelegram(arrayBuffer, fileName, mimeType, config);
        }
    } else {
        return await storeFileInTelegram(arrayBuffer, fileName, mimeType, config);
    }
}
async function storeFileInTelegram(arrayBuffer, fileName, mimeType, config) {
    if (!config.tgBotToken || !config.tgStorageChatId) {
        throw new Error('未配置Telegram存储参数 (TG_BOT_TOKEN 和 TG_STORAGE_CHAT_ID)');
    }
    const formData = new FormData();
    const blob = new Blob([arrayBuffer], { type: mimeType || 'application/octet-stream' });
    formData.append('document', blob, fileName);
    const response = await fetch(`https://api.telegram.org/bot${config.tgBotToken}/sendDocument?chat_id=${config.tgStorageChatId}`, {
        method: 'POST',
        body: formData
    });
    const result = await response.json();
    if (result.ok) {
        const fileId = result.result.document.file_id;
        const fileUrl = await getTelegramFileUrl(fileId, config.tgBotToken, config);
        return fileUrl;
    } else {
        throw new Error('Telegram存储失败: ' + JSON.stringify(result));
    }
}
async function getFile(fileId, config) {
    if (config.bucket) {
        try {
            return await config.bucket.get(fileId);
        } catch (error) {
            console.error('R2获取文件失败:', error);
            return null;
        }
    }
    return null;
}
async function deleteFile(fileId, config) {
    if (config.bucket) {
        try {
            await config.bucket.delete(fileId);
            return true;
        } catch (error) {
            console.error('R2删除文件失败:', error);
            return false;
        }
    }
    return true;
}
async function fetchNotification() {
    try {
        const response = await fetch('https://raw.githubusercontent.com/iawooo/cftc/refs/heads/main/cftc/panel.md');
        if (!response.ok) {
            return null;
        }
        return await response.text();
    } catch (error) {
        return null;
    }
}
function copyShareUrl(url, fileName) {
    console.log('复制分享链接:', url);
    try {
        navigator.clipboard.writeText(url)
            .then(() => {
                alert('链接已复制到剪贴板: ' + url);
            })
            .catch((err) => {
                console.error('复制失败:', err);
                prompt('请手动复制以下链接:', url);
            });
    } catch (error) {
        console.error('复制出错:', error);
        prompt('请手动复制以下链接:', url);
    }
}
try {
    document.addEventListener('DOMContentLoaded', function () {
        try {
            console.log('DOM加载完成，初始化页面元素引用');
            window.editSuffixModal = document.getElementById('editSuffixModal');
            if (window.editSuffixModal) {
                console.log('成功获取修改后缀弹窗元素');
            } else {
                console.error('无法获取修改后缀弹窗元素');
            }
            window.currentEditUrl = '';
            window.shareFile = shareFile;
            window.showConfirmModal = showConfirmModal;
            window.showEditSuffixModal = showEditSuffixModal;
            window.deleteFile = deleteFile;
            window.handleConfirmModalConfirm = handleConfirmModalConfirm;
            window.closeConfirmModal = closeConfirmModal;
            window.confirmModal = document.getElementById('confirmModal');
            window.confirmModalMessage = document.getElementById('confirmModalMessage');
            window.confirmModalConfirm = document.getElementById('confirmModalConfirm');
            window.confirmModalCancel = document.getElementById('confirmModalCancel');
        } catch (error) {
            console.error('初始化页面元素引用时出错:', error);
        }
    });
} catch (error) {
    console.error('添加DOMContentLoaded事件监听器失败:', error);
}
