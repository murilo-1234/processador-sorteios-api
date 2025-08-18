# 🔍 MONITORAMENTO CONTÍNUO DE SORTEIOS - IMPLEMENTADO

## 🎯 **RESUMO DA IMPLEMENTAÇÃO**

Sistema atualizado para **monitoramento contínuo** de sorteios com postagem automática **5 minutos após** a realização, verificando a planilha **a cada 30 minutos** nos horários **:05 e :35**.

## ⏰ **NOVA CONFIGURAÇÃO DE HORÁRIOS**

### **MONITORAMENTO:**
- **Frequência**: A cada 30 minutos
- **Horários**: 10:05, 10:35, 11:05, 11:35, 12:05, 12:35...
- **Cron**: `5,35 * * * *`

### **POSTAGEM:**
- **Delay**: 5 minutos após o sorteio
- **Exemplo**: Sorteio às 19:00 → Posta às 19:05 (se sistema verificar às 19:05)

## 📊 **ESTRUTURA DA PLANILHA ATUALIZADA**

| Código | Data | Hora | Prêmio | URL Resultado | Postado |
|--------|------|------|--------|---------------|---------|
| a09 | 15/08/2025 | 19:00 | iPhone 15 | https://... | 15/08/2025 19:05 |
| b10 | 15/08/2025 | 14:30 | AirPods | https://... | |
| c11 | 16/08/2025 | 21:15 | MacBook | https://... | |

### **COLUNAS NECESSÁRIAS:**
- **Código**: Identificador único do sorteio
- **Data**: Data do sorteio (dd/MM/yyyy)
- **Hora**: Horário do sorteio (HH:mm)
- **Prêmio**: Nome do prêmio
- **URL Resultado**: Link para resultado
- **Postado**: Data/hora da postagem (preenchido automaticamente)

## 🔄 **FLUXO DE FUNCIONAMENTO**

### **1. MONITORAMENTO CONTÍNUO:**
```
10:05 → Verifica planilha
10:35 → Verifica planilha  
11:05 → Verifica planilha
11:35 → Verifica planilha
...
```

### **2. DETECÇÃO DE SORTEIOS ELEGÍVEIS:**
```javascript
// Para cada sorteio na planilha:
1. Tem data e hora? ✅
2. Já foi postado? (coluna "Postado" vazia) ✅
3. Já passou do horário + 5 min? ✅
4. Está dentro da janela (24h)? ✅
```

### **3. PROCESSAMENTO AUTOMÁTICO:**
```
Sorteio: 19:00
Sistema verifica: 19:05
Detecta: Já passou + 5 min
Ação: Processa IMEDIATAMENTE
Resultado: Posta e marca "Postado"
```

## 🛠️ **IMPLEMENTAÇÕES TÉCNICAS**

### **1. JOB SCHEDULER ATUALIZADO:**
```javascript
// Substituído job fixo 18:15 por monitoramento contínuo
this.scheduleJob('monitor-sorteios', {
  schedule: '5,35 * * * *',
  handler: this.handleMonitoramentoSorteios.bind(this)
});
```

### **2. GOOGLE SHEETS SERVICE EXPANDIDO:**
- ✅ `getSorteiosElegiveis()` - Busca sorteios prontos para postar
- ✅ `verificarElegibilidade()` - Verifica se sorteio deve ser processado
- ✅ `construirDataHoraCompleta()` - Combina data + hora
- ✅ `marcarComoPostado()` - Atualiza coluna "Postado"
- ✅ `extrairHoraSorteio()` - Extrai hora da planilha

### **3. MÓDULO SORTEIOS APRIMORADO:**
- ✅ `monitorarSorteiosElegiveis()` - Método principal de monitoramento
- ✅ `processarSorteioElegivel()` - Processa sorteio que já passou do horário
- ✅ Integração com planilha para marcar como postado

### **4. UTILITÁRIOS DE DATA EXPANDIDOS:**
- ✅ `calcularHorarioPostagem()` - Sorteio + 5 minutos
- ✅ `jaPassouHorarioPostagem()` - Verifica se deve postar
- ✅ `getProximoMonitoramento()` - Próximo :05 ou :35
- ✅ `isHorarioMonitoramento()` - Verifica se é :05 ou :35
- ✅ `estaEmJanelaProcessamento()` - Janela de 24h

## 🎯 **VANTAGENS DO NOVO SISTEMA**

### **✅ MAIS INTELIGENTE:**
- Posta **próximo ao horário real** do sorteio
- **Não perde** sorteios de outros horários
- **Maior engajamento** (resultado "fresco")

### **✅ MAIS FLEXÍVEL:**
- **Qualquer horário** de sorteio funciona
- **Múltiplos sorteios** por dia
- **Sem horário fixo** de 18:15

### **✅ MAIS CONFIÁVEL:**
- **Double-check** para evitar duplicatas
- **Marca na planilha** quando postado
- **Janela de 24h** para não perder sorteios antigos

## 🔧 **CONFIGURAÇÕES DISPONÍVEIS**

### **VARIÁVEIS DE AMBIENTE:**
```env
CRON_SCHEDULE_MONITOR=5,35 * * * *  # Horários de monitoramento
TIMEZONE=America/Sao_Paulo          # Timezone brasileiro
```

### **PARÂMETROS AJUSTÁVEIS:**
- **Delay de postagem**: 5 minutos (pode alterar no código)
- **Janela de processamento**: 24 horas (pode alterar)
- **Frequência de monitoramento**: 30 minutos (pode alterar)

## 📈 **EXEMPLOS PRÁTICOS**

### **CENÁRIO 1: Sorteio às 19:00**
```
19:00 → Sorteio realizado
19:05 → Sistema monitora e detecta
19:05 → Processa e posta imediatamente
19:05 → Marca "Postado: 15/08/2025 19:05"
```

### **CENÁRIO 2: Sorteio às 14:30**
```
14:30 → Sorteio realizado
14:35 → Sistema monitora e detecta
14:35 → Processa e posta imediatamente
14:35 → Marca "Postado: 15/08/2025 14:35"
```

### **CENÁRIO 3: Sorteio às 22:00**
```
22:00 → Sorteio realizado
22:05 → Sistema monitora e detecta
22:05 → Processa e posta imediatamente
22:05 → Marca "Postado: 15/08/2025 22:05"
```

## 🚀 **COMO USAR**

### **1. ATUALIZAR PLANILHA:**
- Adicionar coluna **"Hora"** (formato HH:mm)
- Adicionar coluna **"Postado"** (deixar vazia)
- Preencher data e hora de cada sorteio

### **2. FAZER DEPLOY:**
- Substituir arquivos no GitHub
- Deploy automático no Render
- Sistema começa a monitorar automaticamente

### **3. MONITORAR FUNCIONAMENTO:**
- Verificar logs nos horários :05 e :35
- Acompanhar coluna "Postado" sendo preenchida
- Confirmar postagens nos grupos

## 🎉 **RESULTADO FINAL**

O sistema agora é **100% automático e inteligente**:
- ✅ **Monitora continuamente** a planilha
- ✅ **Detecta sorteios** automaticamente
- ✅ **Posta 5 minutos** após realização
- ✅ **Funciona 24/7** sem intervenção
- ✅ **Suporta qualquer horário** de sorteio
- ✅ **Evita duplicatas** com controle na planilha

**Sistema pronto para produção!** 🚀

