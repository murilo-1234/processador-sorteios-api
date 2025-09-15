// src/services/promo-texts.js
'use strict';

// Textos de divulgação — usar {{PRODUTO}} e {{COUPON}} como placeholders.

const beforeTexts = [
`*👉Oooi!! Tem prêmio pra vc*, um TOP Perfume Natura? Entre no sorteio para ganhar esse {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria

*2x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7

*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🤩 *GANHE um BRINDE* da Natura. Veja👇
https://www.natura.com.br/c/brinde?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*🎁Olá!! Tem um presentão* Top te esperando… Entre no sorteio e descubra: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria

*2x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7

*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

💥 *LIQUIDAÇÃO de SABONETES* Natura. Use meu cupom {{COUPON}}. Pega👇
https://www.natura.com.br/c/corpo-e-banho-sabonete?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*👀Viu!? Qual é o prêmio?* Curioso? Participe do sorteio e leve: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria

*2x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7

*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🧴 *Promo do dia*: use {{COUPON}} e ganhe até 60% OFF + frete grátis👇
https://www.natura.com.br/c/promocoes?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*✨Oi... tem presente top* chegando pra vc! Entre no sorteio e concorra ao: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria

*2x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7

*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

⚡ *LIQUIDA RELÂMPAGO - 39 itens com 60%Off* com meu cupom {{COUPON}}👇
https://www.natura.com.br/c/promocoes?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*🔥Olha! Tem um mimo premium* te esperando… Vem pro sorteio e concorra ao: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria

*2x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7

*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🚀 *GARANTO 40%Off com meu cupom* {{COUPON}} acima 3 itens do link👇
https://www.natura.com.br/c/promocao-da-semana?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*🌟Pega! Tem prêmio te chamando!* Garanta sua vaga no sorteio e pode ser seu: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria

*2x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7

*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

💥 *LIQUIDAÇÃO de SABONETES Natura*. Use meu cupom {{COUPON}}. Pega👇
https://www.natura.com.br/c/corpo-e-banho-sabonete?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*💫Oi, rápido! Tem presente* perfumado pra vc. Entra no sorteio e descubra: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria

*2x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7

*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🔥 *12 Perfumes e Cremes na LIQUIDA RELÂMPAGO*. Use meu cupom {{COUPON}}👇
https://www.natura.com.br/c/relampago?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*🛍️Olá! Seu presente*, qual escolhi pra vc? Entre agora no sorteio e concorra ao: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria

*2x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7

*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🔥 *EKOS, KAIAK, UNA e ESSENCIAL até 70%Off* com meu cupom {{COUPON}}👇
https://www.natura.com.br/c/promocoes?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*🎉Oi, veja! Tem presentão* surpresa! Participe do sorteio e você pode ganhar: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria

*2x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7

*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🔥 *PRESENTES até 70%Off* com meu cupom {{COUPON}}👇
https://www.natura.com.br/c/presentes?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*💎Oi, é seu? Um prêmio classe A* te espera… Entre no sorteio e o presente pode ser seu: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria

*2x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7

*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🚨 *O MELHOR do MUNDO em LIQUIDAÇÃO*. Use meu cupom {{COUPON}}👇
https://www.natura.com.br/c/corpo-e-banho-sabonete-barra?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,
];

const dayTexts = [
`*🔥Oi, é hoje!* Teste sua sorte! Ganhe esse prêmio {{PRODUTO}}! 

*🚀3X mais SORTE! Entre 3x na lista do sorteio👇*
*1x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7
*2x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria
*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

💥 *LIQUIDAÇÃO de SABONETES* Natura. Use meu cupom {{COUPON}}. Pega👇
https://www.natura.com.br/c/corpo-e-banho-sabonete?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*🚨Olaáá!? 18h de hoje você ganha* esse {{PRODUTO}}! 

*🚀3X mais SORTE! Entre 3x na lista do sorteio👇*
*1x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7
*2x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria
*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🚀 *GARANTO 40%Off* com meu cupom {{COUPON}} acima 3 itens do link👇
https://www.natura.com.br/c/promocao-da-semana?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*🚀Olá. Última chamada!* Tem sorte pra você aqui! Ganhe esse {{PRODUTO}}!

*🚀3X mais SORTE! Entre 3x na lista do sorteio👇*
*1x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7
*2x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria
*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🔥 *12 Perfumes e Cremes na LIQUIDA RELÂMPAGO*. Use meu cupom {{COUPON}}👇
https://www.natura.com.br/c/relampago?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*⚡Oooi. Tá valendo!* Corre e Ganhe esse {{PRODUTO}}!

*🚀3X mais SORTE! Entre 3x na lista do sorteio👇*
*1x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7
*2x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria
*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🔥 *EKOS, KAIAK, UNA e ESSENCIAL até 70%Off* com meu cupom {{COUPON}}👇
https://www.natura.com.br/c/promocoes?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*🎯Eeeii... sua chance hoje*! Não fica de fora! Ganhe esse {{PRODUTO}}!

*🚀3X mais SORTE! Entre 3x na lista do sorteio👇*
*1x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7
*2x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria
*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🔥 *PRESENTES até 65%Off* com meu cupom {{COUPON}}👇
https://www.natura.com.br/c/presentes?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*🥳Opa... É agora! Última chamada!* Ganhe esse {{PRODUTO}}!

*🚀3X mais SORTE! Entre 3x na lista do sorteio👇*
*1x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7
*2x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria
*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🧴 *Promo do dia*: use {{COUPON}} e ganhe até 60% OFF + frete grátis👇
https://www.natura.com.br/c/promocoes?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*🛎️Ei... atenção!* Ganhe esse {{PRODUTO}}!

*🚀3X mais SORTE! Entre 3x na lista do sorteio👇*
*1x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7
*2x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria
*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🚨 *O MELHOR do MUNDO em LIQUIDAÇÃO*. Use meu cupom {{COUPON}}👇
https://www.natura.com.br/c/corpo-e-banho-sabonete-barra?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*🌟Oi! Hoje tem! Sua chance chegou!* Ganhe esse {{PRODUTO}}!

*🚀3X mais SORTE! Entre 3x na lista do sorteio👇*
*1x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7
*2x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria
*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

💥 *LIQUIDAÇÃO de SABONETES Natura*. Use meu cupom {{COUPON}}. Pega👇
https://www.natura.com.br/c/corpo-e-banho-sabonete?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*📣Olá. Chamada geral!* Participa já! Ganhe esse {{PRODUTO}}!

*🚀3X mais SORTE! Entre 3x na lista do sorteio👇*
*1x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7
*2x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria
*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

🤩 *GANHE um BRINDE* da Natura. Veja👇
https://www.natura.com.br/c/brinde?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,

`*🏁Eeei... partiu testar a sorte?* Último chamado! Ganhe esse {{PRODUTO}}!

*🚀3X mais SORTE! Entre 3x na lista do sorteio👇*
*1x- ENVIE👉* " 7 " para o Whatsapp  48 99102-1707 
link: https://wa.me/554891021707?text=7
*2x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria
*3x- ENVIE👉* " 7 " no Messenger👇
http://m.me/murilocerqueiraconsultor

⚡ *LIQUIDA RELÂMPAGO - 39 itens* com 60%Off com meu cupom {{COUPON}}👇
https://www.natura.com.br/c/promocoes?consultoria=clubemac

*💳 Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ https://www.natura.com.br/consultoria/clubemac
*🎟️ Cupom extra*: {{COUPON}}
*🚚 Frete grátis* acima de R$99
*🎯 Mais cupons*: https://bit.ly/cupons-murilo`,
];

module.exports = { beforeTexts, dayTexts };
