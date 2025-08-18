// Sistema de banco de dados robusto com fallback automático
// Tenta better-sqlite3 primeiro (mais estável no Render), depois sqlite3
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

let Database;
let dbInstance;

// Tentar usar better-sqlite3 primeiro (mais estável), depois sqlite3
try {
  Database = require('better-sqlite3');
  logger.info('✅ Usando better-sqlite3 (recomendado para Render)');
} catch (err) {
  try {
    const sqlite3 = require('sqlite3');
    const { open } = require('sqlite');
    logger.info('✅ Usando sqlite3 tradicional');
    
    class SQLite3Wrapper {
      constructor() {
        this.db = null;
        this.dbPath = process.env.DATABASE_PATH || './data/database.sqlite';
      }

      async initialize() {
        try {
          const dbDir = path.dirname(this.dbPath);
          if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
          }

          this.db = await open({
            filename: this.dbPath,
            driver: sqlite3.Database
          });

          await this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA foreign_keys = ON;
          `);

          await this.createTables();
          logger.info('✅ Banco de dados SQLite3 inicializado');
          return this;
        } catch (error) {
          logger.error('❌ Erro ao inicializar SQLite3:', error);
          throw error;
        }
      }

      async createTables() {
        const tables = [
          `CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            active BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`,
          `CREATE TABLE IF NOT EXISTS sorteios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES groups (id)
          )`,
          `CREATE TABLE IF NOT EXISTS participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sorteio_id INTEGER NOT NULL,
            phone TEXT NOT NULL,
            name TEXT,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sorteio_id) REFERENCES sorteios (id)
          )`
        ];

        for (const table of tables) {
          await this.db.exec(table);
        }
      }

      async close() {
        if (this.db) {
          await this.db.close();
          this.db = null;
        }
      }

      async getConnection() {
        return this.db;
      }

      async healthCheck() {
        try {
          const start = Date.now();
          await this.db.get('SELECT 1');
          const responseTime = Date.now() - start;
          
          return { 
            status: 'ok', 
            response_time_ms: responseTime
          };
        } catch (error) {
          return { 
            status: 'error', 
            error: error.message 
          };
        }
      }
    }
    
    Database = SQLite3Wrapper;
  } catch (err2) {
    logger.error('❌ Nenhuma implementação SQLite disponível:', err2);
    throw new Error('SQLite não disponível - instale sqlite3 ou better-sqlite3');
  }
}

class DatabaseManager {
  constructor() {
    this.db = null;
    this.dbPath = process.env.DATABASE_PATH || './data/database.sqlite';
  }

  async initialize() {
    try {
      // Garantir que o diretório existe
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      if (Database.name === 'SQLite3Wrapper') {
        // Usar wrapper do sqlite3
        this.db = new Database();
        await this.db.initialize();
      } else {
        // Usar better-sqlite3
        this.db = new Database(this.dbPath, {
          verbose: process.env.NODE_ENV === 'development' ? console.log : null
        });

        // Configurar PRAGMAs
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');

        await this.createTables();
        logger.info('✅ Banco de dados better-sqlite3 inicializado');
      }

      return this;
    } catch (error) {
      logger.error('❌ Erro ao inicializar banco de dados:', error);
      throw error;
    }
  }

  async createTables() {
    if (Database.name === 'SQLite3Wrapper') {
      // Já criado no wrapper
      return;
    }

    const tables = [
      `CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS sorteios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES groups (id)
      )`,
      `CREATE TABLE IF NOT EXISTS participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sorteio_id INTEGER NOT NULL,
        phone TEXT NOT NULL,
        name TEXT,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sorteio_id) REFERENCES sorteios (id)
      )`
    ];

    for (const table of tables) {
      this.db.exec(table);
    }
  }

  async close() {
    if (this.db) {
      if (typeof this.db.close === 'function') {
        await this.db.close();
      }
      this.db = null;
    }
  }

  async getConnection() {
    if (!this.db) {
      await this.initialize();
    }
    return this.db;
  }

  getDb() {
    return this.db;
  }

  // Método para health check
  async healthCheck() {
    try {
      if (this.db && this.db.healthCheck) {
        return await this.db.healthCheck();
      }
      
      const start = Date.now();
      if (Database.name === 'SQLite3Wrapper') {
        await this.db.db.get('SELECT 1');
      } else {
        this.db.prepare('SELECT 1').get();
      }
      const responseTime = Date.now() - start;
      
      return { 
        status: 'ok', 
        response_time_ms: responseTime
      };
    } catch (error) {
      return { 
        status: 'error', 
        error: error.message 
      };
    }
  }
}

// Singleton
if (!dbInstance) {
  dbInstance = new DatabaseManager();
}

module.exports = dbInstance;

