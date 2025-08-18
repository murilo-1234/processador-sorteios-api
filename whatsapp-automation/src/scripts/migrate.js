#!/usr/bin/env node

/**
 * Script de migração do banco de dados
 * Cria todas as tabelas necessárias para o sistema
 */

const path = require('path');
const fs = require('fs');

// Configurar variáveis de ambiente se não estiverem definidas
if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = './data/database.sqlite';
}

const database = require('../config/database');

async function runMigrations() {
  try {
    console.log('🗄️ Iniciando migrações do banco de dados...');

    // Garantir que o diretório existe
    const dbDir = path.dirname(process.env.DATABASE_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`📁 Diretório criado: ${dbDir}`);
    }

    // Inicializar banco
    await database.initialize();
    console.log('✅ Banco de dados inicializado');

    const db = await database.getConnection();

    // Migração 1: Tabelas básicas
    console.log('📋 Executando migração 1: Tabelas básicas...');
    
    await db.exec(`
      -- Tabela de grupos WhatsApp
      CREATE TABLE IF NOT EXISTS grupos_whatsapp (
        jid TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        ativo_sorteios INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Tabela de textos para sorteios
      CREATE TABLE IF NOT EXISTS textos_sorteios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        texto_template TEXT NOT NULL,
        ativo INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Tabela de cupons atuais
      CREATE TABLE IF NOT EXISTS cupons_atuais (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cupom1 TEXT,
        cupom2 TEXT,
        atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Tabela de sorteios processados
      CREATE TABLE IF NOT EXISTS sorteios_processados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo_sorteio TEXT NOT NULL,
        data_sorteio TEXT NOT NULL,
        nome_premio TEXT,
        ganhador TEXT,
        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(codigo_sorteio, date(processed_at))
      );

      -- Tabela de envios WhatsApp
      CREATE TABLE IF NOT EXISTS envios_whatsapp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE NOT NULL,
        codigo_sorteio TEXT NOT NULL,
        grupo_jid TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        message_key_id TEXT,
        tentativas INTEGER DEFAULT 0,
        ultimo_erro TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        enviado_em DATETIME,
        FOREIGN KEY (grupo_jid) REFERENCES grupos_whatsapp(jid)
      );

      -- Tabela de logs de auditoria
      CREATE TABLE IF NOT EXISTS logs_auditoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        evento TEXT NOT NULL,
        detalhes TEXT,
        usuario TEXT DEFAULT 'system',
        ip_address TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Tabela de notificações
      CREATE TABLE IF NOT EXISTS notifications_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notification_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT,
        priority TEXT DEFAULT 'normal',
        attempts INTEGER DEFAULT 0,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Migração 2: Índices para performance
    console.log('📋 Executando migração 2: Índices...');
    
    await db.exec(`
      -- Índices para performance
      CREATE INDEX IF NOT EXISTS idx_grupos_ativo_sorteios ON grupos_whatsapp(ativo_sorteios);
      CREATE INDEX IF NOT EXISTS idx_grupos_enabled ON grupos_whatsapp(enabled);
      CREATE INDEX IF NOT EXISTS idx_textos_ativo ON textos_sorteios(ativo);
      CREATE INDEX IF NOT EXISTS idx_sorteios_codigo ON sorteios_processados(codigo_sorteio);
      CREATE INDEX IF NOT EXISTS idx_sorteios_data ON sorteios_processados(data_sorteio);
      CREATE INDEX IF NOT EXISTS idx_sorteios_processed_at ON sorteios_processados(processed_at);
      CREATE INDEX IF NOT EXISTS idx_envios_status ON envios_whatsapp(status);
      CREATE INDEX IF NOT EXISTS idx_envios_codigo ON envios_whatsapp(codigo_sorteio);
      CREATE INDEX IF NOT EXISTS idx_envios_created_at ON envios_whatsapp(created_at);
      CREATE INDEX IF NOT EXISTS idx_logs_evento ON logs_auditoria(evento);
      CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs_auditoria(created_at);
      CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications_log(type);
      CREATE INDEX IF NOT EXISTS idx_notifications_sent_at ON notifications_log(sent_at);
    `);

    // Migração 3: Dados iniciais
    console.log('📋 Executando migração 3: Dados iniciais...');
    
    // Inserir textos padrão se não existirem
    const textosExistentes = await db.get('SELECT COUNT(*) as count FROM textos_sorteios');
    
    if (textosExistentes.count === 0) {
      await db.run(`
        INSERT INTO textos_sorteios (texto_template, ativo) VALUES 
        ('🎉 Parabéns {NOME_GANHADOR}! 

Você ganhou o {PREMIO}!

🔗 Veja o resultado completo:
{LINK_RESULTADO}

📞 Fale comigo no WhatsApp: (48) 9 9178-4733

🎁 Use o cupom {CUPOM} e ganhe desconto!', 1),

        ('👑 GANHADOR OFICIAL! 

{NOME_GANHADOR} ganhou o {PREMIO}!

✅ Resultado verificado e confirmado
🔗 {LINK_RESULTADO}

📱 Entre em contato: (48) 9 9178-4733
🎫 Cupom especial: {CUPOM}', 1),

        ('🏆 RESULTADO OFICIAL DO SORTEIO!

🎁 Prêmio: {PREMIO}
👑 Ganhador: {NOME_GANHADOR}

🔍 Confira todos os detalhes:
{LINK_RESULTADO}

💬 WhatsApp: (48) 9 9178-4733
🎟️ Desconto especial: {CUPOM}', 1)
      `);
      
      console.log('✅ Textos padrão inseridos');
    }

    // Inserir cupom padrão se não existir
    const cuponsExistentes = await db.get('SELECT COUNT(*) as count FROM cupons_atuais');
    
    if (cuponsExistentes.count === 0) {
      await db.run(`
        INSERT INTO cupons_atuais (cupom1, cupom2) VALUES ('PEGAJ', 'DESCONTO10')
      `);
      
      console.log('✅ Cupons padrão inseridos');
    }

    // Migração 4: Triggers para updated_at
    console.log('📋 Executando migração 4: Triggers...');
    
    await db.exec(`
      -- Trigger para atualizar updated_at em grupos_whatsapp
      CREATE TRIGGER IF NOT EXISTS update_grupos_timestamp 
      AFTER UPDATE ON grupos_whatsapp
      BEGIN
        UPDATE grupos_whatsapp SET updated_at = CURRENT_TIMESTAMP WHERE jid = NEW.jid;
      END;

      -- Trigger para atualizar updated_at em textos_sorteios
      CREATE TRIGGER IF NOT EXISTS update_textos_timestamp 
      AFTER UPDATE ON textos_sorteios
      BEGIN
        UPDATE textos_sorteios SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;
    `);

    // Verificar integridade
    console.log('🔍 Verificando integridade do banco...');
    
    const tables = await db.all(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);
    
    console.log('📋 Tabelas criadas:');
    tables.forEach(table => {
      console.log(`  ✅ ${table.name}`);
    });

    // Estatísticas
    const stats = await Promise.all([
      db.get('SELECT COUNT(*) as count FROM grupos_whatsapp'),
      db.get('SELECT COUNT(*) as count FROM textos_sorteios'),
      db.get('SELECT COUNT(*) as count FROM cupons_atuais'),
      db.get('SELECT COUNT(*) as count FROM sorteios_processados'),
      db.get('SELECT COUNT(*) as count FROM envios_whatsapp')
    ]);

    console.log('📊 Estatísticas do banco:');
    console.log(`  👥 Grupos: ${stats[0].count}`);
    console.log(`  📝 Textos: ${stats[1].count}`);
    console.log(`  🎫 Cupons: ${stats[2].count}`);
    console.log(`  🎯 Sorteios processados: ${stats[3].count}`);
    console.log(`  📤 Envios: ${stats[4].count}`);

    console.log('✅ Migrações concluídas com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro durante as migrações:', error);
    process.exit(1);
  } finally {
    await database.close();
  }
}

// Executar migrações se chamado diretamente
if (require.main === module) {
  runMigrations().then(() => {
    console.log('🎉 Banco de dados pronto para uso!');
    process.exit(0);
  }).catch(error => {
    console.error('💥 Falha nas migrações:', error);
    process.exit(1);
  });
}

module.exports = { runMigrations };

