// src/services/promo-texts.js
'use strict';

// Textos de divulgação — usar {{PRODUTO}} e {{COUPON}} como placeholders.

const beforeTexts = [
`*👉Oooi!! Tem prêmio pra vc*, um TOP Perfume Natura? Entre no sorteio para ganhar esse {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


🤩 *GANHE um BRINDE da Natura*. É TOP! Veja👇
https://swiy.co/brinde-natura

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*🎁Olá!! Tem um presentão* Top te esperando… Entre no sorteio e descubra: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria

💥 *SABONETES na Liquidação* com Cashback. Surreal! Use meu cupom {{COUPON}}. Pega👇
https://swiy.co/liquida-sabonetes

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*👀Viu!? Qual é o prêmio?* Curioso? Participe do sorteio e leve: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


🔥 *PROMO Preço da BLACK FRIDAY*: use {{COUPON}}. TOPs com 60% OFF + Cashback + frete grátis👇
https://swiy.co/natura-70ou60off

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*✨Oi... tem presente top* chegando pra vc! Entre no sorteio e concorra ao: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


⚡ *PROMO RELÂMPAGO Natura - 39 itens com 60%Off +Cashback* com meu cupom {{COUPON}}👇
https://swiy.co/natura-70ou60off

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*🔥Olha! Tem um mimo premium* te esperando… Vem pro sorteio e concorra ao: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


💪 *🚨GARANTO 50%Off +cashback com meu cupom* {{COUPON}} acima 3 ou 4 itens do link👇
https://swiy.co/50a60off-natura

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*🌟Pega! Tem prêmio te chamando!* Garanta sua vaga no sorteio e pode ser seu: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


😱 *SABONETES só R$ 4 cada na Natura +cashback*. Use meu cupom {{COUPON}}. Pega👇
https://swiy.co/liquida-sabonetes

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*💫Oi, rápido! Tem presente* perfumado pra vc. Entra no sorteio e descubra: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


🔥 *17 Natura RELÂMPAGO +cashback*. Use meu cupom {{COUPON}}👇
https://swiy.co/relampago-natura

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*🛍️Olá! Seu presente*, qual escolhi pra vc? Entre agora no sorteio e concorra ao: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


🔥 *Tem alguns EKOS, KAIAK, UNA e ESSENCIAL com 70%Off +cashback* com meu cupom {{COUPON}}👇
https://swiy.co/natura-70ou60off

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*🎉Oi, veja! Tem presentão* surpresa! Participe do sorteio e você pode ganhar: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


🎁 *👏PRESENTES até 70%Off na Natura* com meu cupom {{COUPON}} +cashback. Compre Natal antes para economizar👇
https://swiy.co/presentes-natura

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*💎Oi, é seu? Um prêmio classe A* te espera… Entre no sorteio e o presente pode ser seu: {{PRODUTO}}.

*1x- ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


🚨 *O MELHOR do MUNDO em Natura liquidando +cashback*. Use meu cupom {{COUPON}}👇
https://swiy.co/liquida-sabonetes

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,
];

const dayTexts = [
`*🔥Oi, é hoje!* Teste sua sorte! Ganhe esse prêmio {{PRODUTO}}! 

*🚀Entre na lista do sorteio👇*
*ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


💥 *SABONETES em LIQUIDAÇÃO*. Muuuuito barato +cashback. Use meu cupom {{COUPON}}. Pega👇
https://swiy.co/liquida-sabonetes

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*🚨Olaáá!? 18h de hoje você ganha* esse {{PRODUTO}}! 

*🚀Entre na lista do sorteio👇*
*ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


🚀 *GARANTO 50%Off +cashback* com meu cupom {{COUPON}} acima 3 a 4 itens do link👇
https://swiy.co/50a60off-natura

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*🚀Olá. Última chamada!* Tem sorte pra você aqui! Ganhe esse {{PRODUTO}}!

*🚀Entre na lista do sorteio👇*
*ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


🔥 *TOP Perfume Essencial, Luna por R$38 e R$46 +cashback*. Use meu cupom {{COUPON}}👇
https://swiy.co/relampago-natura

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*⚡Oooi. Tá valendo!* Corre e Ganhe esse {{PRODUTO}}!

*🚀Entre na lista do sorteio👇*
*ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


🔥 *EKOS, KAIAK, UNA e ESSENCIAL até 70%Off +cashback* com meu cupom {{COUPON}}👇
https://swiy.co/natura-70ou60off

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*🎯Eeeii... sua chance hoje*! Não fica de fora! Ganhe esse {{PRODUTO}}!

*🚀Entre na lista do sorteio👇*
*ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


🔥 *🎁PRESENTES até 65%Off +cashback* com meu cupom {{COUPON}}. Compre Natal agora. É mais barato.👇
https://swiy.co/presentes-natura

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*🥳Opa... É agora! Última chamada!* Ganhe esse {{PRODUTO}}!

*🚀Entre na lista do sorteio👇*
*ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


😱 *Promo do Dia da Natura: use {{COUPON}} e ganhe até 60% OFF +cashback + frete grátis👇*
https://swiy.co/natura-70ou60off

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*🛎️Ei... atenção!* Ganhe esse {{PRODUTO}}!

*🚀Entre na lista do sorteio👇*
*ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


🚨 *O MELHOR do MUNDO em LIQUIDAÇÃO +cashback*. Use meu cupom {{COUPON}}👇
https://swiy.co/liquida-sabonetes

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*🌟Oi! Hoje tem! Sua chance chegou!* Ganhe esse {{PRODUTO}}!

*🚀Entre na lista do sorteio👇*
*ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


💥 *LIQUIDAÇÃO de SABONETES só R$4 +cashback (cada um)*. Use meu cupom {{COUPON}}. Pega👇
https://swiy.co/liquida-sabonetes

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*📣Olá. Chamada geral!* Participa já! Ganhe esse {{PRODUTO}}!

*🚀Entre na lista do sorteio👇*
*ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


🤩 *GANHE um BRINDE MUUUUITO TOP*. Veja👇
https://swiy.co/brinde-natura

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,

`*🏁Eeei... partiu testar a sorte?* Último chamado! Ganhe esse {{PRODUTO}}!

*🚀Entre na lista do sorteio👇*
*ENVIE👉* " 7 " no Instagram👇 
https://ig.me/m/murilo_cerqueira_consultoria


⚡ *LIQUIDA RELÂMPAGO! 39 itens com 70%Off + cashback* com meu cupom {{COUPON}}👇
https://swiy.co/natura-70ou60off

💳 *Procure por Murilo Cerqueira* - cupons só valem aqui.
🛍️ *Natura:* https://swiy.co/promo-natura
🧼 *Sabonetes:* https://swiy.co/promo-sabonetes
📌 *AVON:* https://swiy.co/loja-avon
❤️ *Disney:* https://swiy.co/disney-promos
🎟️ *Cupom extra*: {{COUPON}}
🚚 *Frete grátis* > R$99 ou R$149 (verificar)
🎯 *Mais cupons*: https://swiy.co/cupons-murilo e https://swiy.co/cupons-extras`,
];

module.exports = { beforeTexts, dayTexts };
