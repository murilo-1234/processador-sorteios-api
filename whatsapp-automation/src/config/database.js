const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

class Database {
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

      // Abrir conexão com o banco
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database
      });

      // Configurar PRAGMAs para produção
      await this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA cache_size = 2000;
      `);

      console.log('✅ SQLite configurado para produção');
      
      // Executar migrações
      await this.runMigrations();
      
      return this.db;
    } catch (error) {
      console.error('❌ Erro ao inicializar banco de dados:', error);
      throw error;
    }
  }

  async runMigrations() {
    try {
      // Criar tabela de migrações se não existir
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          executed_at DATETIME DEFAULT (datetime('now', 'utc'))
        );
      `);

      // Lista de migrações
      const migrations = [
        '001_initial_schema.sql',
        '002_add_indexes.sql',
        '003_add_triggers.sql'
      ];

      for (const migration of migrations) {
        const executed = await this.db.get(
          'SELECT name FROM migrations WHERE name = ?',
          [migration]
        );

        if (!executed) {
          console.log(`🔄 Executando migração: ${migration}`);
          await this.executeMigration(migration);
          await this.db.run(
            'INSERT INTO migrations (name) VALUES (?)',
            [migration]
          );
          console.log(`✅ Migração executada: ${migration}`);
        }
      }
    } catch (error) {
      console.error('❌ Erro ao executar migrações:', error);
      throw error;
    }
  }

  async executeMigration(migrationName) {
    const migrationPath = path.join(__dirname, '../migrations', migrationName);
    
    if (fs.existsSync(migrationPath)) {
      const sql = fs.readFileSync(migrationPath, 'utf8');
      await this.db.exec(sql);
    } else {
      // Migrações inline para facilitar deploy
      switch (migrationName) {
        case '001_initial_schema.sql':
          await this.createInitialSchema();
          break;
        case '002_add_indexes.sql':
          await this.addIndexes();
          break;
        case '003_add_triggers.sql':
          await this.addTriggers();
          break;
        default:
          throw new Error(`Migração não encontrada: ${migrationName}`);
      }
    }
  }

  async createInitialSchema() {
    await this.db.exec(`
      -- Tabela de execuções de jobs
      CREATE TABLE IF NOT EXISTS job_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        run_seq INTEGER NOT NULL DEFAULT 1,
        reason TEXT,
        payload_json TEXT NOT NULL,
        status TEXT CHECK (status IN ('queued','running','done','failed')),
        started_at DATETIME,
        finished_at DATETIME,
        error_message TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'utc'))
      );

      -- Tabela de envios WhatsApp
      CREATE TABLE IF NOT EXISTS envios_whatsapp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL,
        message_key_id TEXT,
        codigo_sorteio TEXT NOT NULL,
        grupo_jid TEXT NOT NULL,
        status TEXT CHECK (status IN ('pending','sending','sent','delivered','failed_retry','failed_perm')),
        tentativas INTEGER DEFAULT 0,
        ultimo_erro TEXT,
        enviado_em DATETIME,
        created_at DATETIME DEFAULT (datetime('now', 'utc')),
        updated_at DATETIME DEFAULT (datetime('now', 'utc'))
      );

      -- Tabela de grupos WhatsApp
      CREATE TABLE IF NOT EXISTS grupos_whatsapp (
        jid TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        ativo_sorteios INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT (datetime('now', 'utc'))
      );

      -- Tabela de textos para sorteios
      CREATE TABLE IF NOT EXISTS textos_sorteios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        texto_template TEXT NOT NULL,
        ativo INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT (datetime('now', 'utc'))
      );

      -- Tabela de sessões admin
      CREATE TABLE IF NOT EXISTS admin_sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire DATETIME NOT NULL
      );

      -- Tabela de logs de auditoria
      CREATE TABLE IF NOT EXISTS logs_auditoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        evento TEXT NOT NULL,
        detalhes TEXT,
        user_id TEXT,
        ip_address TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'utc'))
      );

      -- Tabela de sorteios processados
      CREATE TABLE IF NOT EXISTS sorteios_processados (
        codigo_sorteio TEXT PRIMARY KEY,
        data_sorteio TEXT NOT NULL,
        nome_premio TEXT,
        ganhador TEXT,
        processed_at DATETIME DEFAULT (datetime('now', 'utc'))
      );

      -- Tabela de cupons atuais
      CREATE TABLE IF NOT EXISTS cupons_atuais (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cupom1 TEXT NOT NULL,
        cupom2 TEXT NOT NULL,
        fonte TEXT DEFAULT 'clubemac.com.br',
        atualizado_em DATETIME DEFAULT (datetime('now', 'utc'))
      );

      -- Tabela de configurações do sistema
      CREATE TABLE IF NOT EXISTS configuracoes_sistema (
        chave TEXT PRIMARY KEY,
        valor TEXT NOT NULL,
        descricao TEXT,
        updated_at DATETIME DEFAULT (datetime('now', 'utc'))
      );
    `);
  }

  async addIndexes() {
    await this.db.exec(`
      -- Índices para performance
      CREATE UNIQUE INDEX IF NOT EXISTS uq_job_dedupe_run 
        ON job_executions(job_type, dedupe_key, run_seq);

      CREATE UNIQUE INDEX IF NOT EXISTS uq_envio_idempotency 
        ON envios_whatsapp(idempotency_key);

      CREATE UNIQUE INDEX IF NOT EXISTS uq_envio_message_key 
        ON envios_whatsapp(message_key_id) WHERE message_key_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_envios_status 
        ON envios_whatsapp(status);

      CREATE INDEX IF NOT EXISTS idx_envios_grupo 
        ON envios_whatsapp(grupo_jid);

      CREATE INDEX IF NOT EXISTS idx_jobs_status 
        ON job_executions(status);

      CREATE INDEX IF NOT EXISTS idx_admin_sessions_expire 
        ON admin_sessions(expire);

      CREATE INDEX IF NOT EXISTS idx_logs_auditoria_created 
        ON logs_auditoria(created_at);

      CREATE INDEX IF NOT EXISTS idx_sorteios_processed_date 
        ON sorteios_processados(processed_at);
    `);
  }

  async addTriggers() {
    await this.db.exec(`
      -- Trigger para updated_at automático
      CREATE TRIGGER IF NOT EXISTS trg_envios_updated_at
      AFTER UPDATE ON envios_whatsapp
      FOR EACH ROW
      BEGIN
        UPDATE envios_whatsapp SET updated_at = datetime('now','utc') WHERE id = NEW.id;
      END;

      -- Trigger para limpeza automática de sessões expiradas
      CREATE TRIGGER IF NOT EXISTS trg_cleanup_expired_sessions
      AFTER INSERT ON admin_sessions
      FOR EACH ROW
      BEGIN
        DELETE FROM admin_sessions WHERE expire < datetime('now');
      END;
    `);
  }

  async getConnection() {
    if (!this.db) {
      await this.initialize();
    }
    return this.db;
  }

  async close() {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  // Método para health check
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

module.exports = new Database();

