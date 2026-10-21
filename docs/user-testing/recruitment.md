# Recruitment Kit — Turbolong User Testing

Outreach, screener, setup kit and consent for the programme in
[`README.md`](README.md). Participant-facing text is in EN / ES / PT-BR.

**Before sending anything, fill in:**

- `{CONTACT}`: a team inbox participants can write to. Not `security@`.
- `{SCREENER_LINK}`: the form built from §2.
- `{INCENTIVE}`: suggested "USD 30 in USDC".
- `{APP_LINK}`.

---

## 1. Outreach post

Post in the Spanish and Portuguese channels of the Stellar and Blend community
spaces the team belongs to, on Turbolong's own channels, and in LatAm crypto
groups members already know. Ask each participant to refer one person (referrals
still go through the screener).

**EN**
> **Help us test Turbolong (60 min, {INCENTIVE})**
> We're looking for people to try Turbolong, a leveraged-yield app on Stellar, and tell us honestly where it's confusing. It's a 60-minute video call in English, Spanish or Portuguese. Everything happens on Stellar's **test network**, so no real money is involved. As a thank-you you'll receive {INCENTIVE}. Sign up (2 minutes): {SCREENER_LINK}

**ES**
> **Ayúdanos a probar Turbolong (60 min, {INCENTIVE})**
> Buscamos personas que prueben Turbolong, una app de rendimiento apalancado en Stellar, y nos digan con honestidad qué les resulta confuso. Es una videollamada de 60 minutos en español, portugués o inglés. Todo ocurre en la **red de prueba** de Stellar, así que no hay dinero real en juego. Como agradecimiento recibirás {INCENTIVE}. Inscríbete (2 minutos): {SCREENER_LINK}

**PT-BR**
> **Ajude a testar o Turbolong (60 min, {INCENTIVE})**
> Procuramos pessoas para experimentar o Turbolong, um app de rendimento alavancado na Stellar, e dizer com sinceridade o que é confuso. É uma videochamada de 60 minutos em português, espanhol ou inglês. Tudo acontece na **rede de teste** da Stellar, então não há dinheiro de verdade envolvido. Como agradecimento você recebe {INCENTIVE}. Inscreva-se (2 minutos): {SCREENER_LINK}

## 2. Screener

Build this as a form, offered in all three languages. The **→** notes are for
the team only. Don't show them on the form.

| # | EN | ES | PT-BR | Options → use |
|---|---|---|---|---|
| 1 | Which country do you live in? | ¿En qué país vives? | Em que país você mora? | Country list → **LatAm cohort** if Mexico, Central/South America, or the Spanish/Portuguese-speaking Caribbean |
| 2 | Which language would you like the session in? | ¿En qué idioma prefieres la sesión? | Em que idioma você prefere a sessão? | Español / Português / English → `language` |
| 3 | In the last 12 months, which of these have you done **with your own money**? (select all) | En los últimos 12 meses, ¿cuáles de estas cosas hiciste **con tu propio dinero**? (marca todas) | Nos últimos 12 meses, quais destas coisas você fez **com seu próprio dinheiro**? (marque todas) | see 3a–3h |
| 3a | Bought or held crypto | Comprar o mantener cripto | Comprar ou manter cripto | |
| 3b | Swapped tokens on a decentralised exchange (DEX) | Intercambiar tokens en un exchange descentralizado (DEX) | Trocar tokens numa exchange descentralizada (DEX) | |
| 3c | Lent / supplied crypto on an on-chain lending protocol (e.g. Blend, Aave, Morpho, Kamino) | Prestar / depositar cripto en un protocolo de préstamos on-chain (p. ej. Blend, Aave, Morpho, Kamino) | Emprestar / depositar cripto num protocolo de empréstimos on-chain (ex.: Blend, Aave, Morpho, Kamino) | → **DeFi-native** |
| 3d | Borrowed on-chain against crypto collateral | Pedir prestado on-chain usando cripto como garantía | Pegar empréstimo on-chain usando cripto como garantia | → **DeFi-native** |
| 3e | Used leverage on-chain (looping, a perpetuals DEX) | Usar apalancamiento on-chain (looping, un DEX de perpetuos) | Usar alavancagem on-chain (looping, uma DEX de perpétuos) | → **DeFi-native** |
| 3f | Used leverage on a centralised exchange (Binance, Bybit…) | Usar apalancamiento en un exchange centralizado (Binance, Bybit…) | Usar alavancagem numa exchange centralizada (Binance, Bybit…) | Not DeFi-native on its own. Note it: a useful sub-group |
| 3g | Deposited into a yield vault or auto-compounder | Depositar en un vault de rendimiento o auto-compounder | Depositar num vault de rendimento ou auto-compounder | |
| 3h | None of these | Ninguna de estas | Nenhuma destas | 3h alone → **exclude** (needs basic wallet familiarity) |
| 4 | Which Stellar wallets have you used? (select all) | ¿Qué billeteras de Stellar usaste? (marca todas) | Quais carteiras da Stellar você já usou? (marque todas) | LOBSTR / Freighter / xBull / Albedo / Hana / Vibrant / Beans / Ledger / Other / None → context; reveals wallets we don't support |
| 5 | Which device would you use for the session? | ¿Qué dispositivo usarías para la sesión? | Qual dispositivo você usaria na sessão? | Computer / Android phone / iPhone → `device`; fill the ≥ 3 mobile quota from LatAm |
| 6 | Do you work for, or have you contributed to, Turbolong, Blend or the Stellar Development Foundation? | ¿Trabajas o contribuiste en Turbolong, Blend o la Stellar Development Foundation? | Você trabalha ou já contribuiu com Turbolong, Blend ou a Stellar Development Foundation? | Yes → **exclude** |
| 7 | Have you taken part in a Turbolong study before? | ¿Participaste antes en un estudio de Turbolong? | Você já participou de um estudo do Turbolong? | Yes → **exclude** |
| 8 | Is it OK to record your screen and voice during the session? | ¿Está bien grabar tu pantalla y tu voz durante la sesión? | Tudo bem gravar sua tela e sua voz durante a sessão? | Yes / Notes only → both eligible |
| 9 | Email or Telegram, only to schedule the session | Email o Telegram, solo para agendar la sesión | E-mail ou Telegram, só para agendar a sessão | Kept in the private sheet only |

**Selection:**

- Fill the cells of the quota matrix (README §3): LatAm × DeFi-native 5, LatAm ×
  not 3, other × DeFi-native 3, other × not 1. Over-recruit each cell by about
  a third.
- Within each cell, prefer variety of country, wallet and device.
- Record the cohort result as the session's `cohorts` list. Never copy screener
  answers into the repo.

## 3. Confirmation and setup kit

Send this after scheduling, with the calendar invite. The desktop setup takes
about 10 minutes and must be done **before** the call. Phone participants set up
on the call.

**EN**
> Thanks for signing up! Your session: **{DATE, TIME, TIMEZONE}**, video call link: {LINK}.
>
> **Before the call (computer, ~10 min):**
> 1. Create a **new browser profile** (Chrome or Brave: profile icon → *Add*), so your real wallets and balances never appear on screen.
> 2. In that profile, install the **Freighter** extension from freighter.app.
> 3. Create a **new** wallet. It's only for this test. Keep the recovery phrase to yourself: **never share it with anyone, including us. We will never ask for it.**
> 4. In Freighter's settings, switch the network to **Test Net**.
> 5. If Freighter shows a **Fund with Friendbot** button, click it. You'll get 10,000 test XLM. If not, don't worry: we'll fund it at the start of the call.
>
> **Joining from your phone?** Skip the steps above. We'll set up a test wallet together in the first minutes. Please be on Wi-Fi with your battery charged, and have the video-call app installed so you can share your phone screen.
>
> Questions or need to reschedule? {CONTACT}

**ES**
> ¡Gracias por inscribirte! Tu sesión: **{FECHA, HORA, ZONA HORARIA}**, link de la videollamada: {LINK}.
>
> **Antes de la llamada (computadora, ~10 min):**
> 1. Crea un **nuevo perfil del navegador** (Chrome o Brave: ícono de perfil → *Agregar*), para que tus billeteras y saldos reales nunca aparezcan en pantalla.
> 2. En ese perfil, instala la extensión **Freighter** desde freighter.app.
> 3. Crea una billetera **nueva**. Es solo para esta prueba. Guarda la frase de recuperación para ti: **nunca la compartas con nadie, tampoco con nosotros. Nunca te la vamos a pedir.**
> 4. En la configuración de Freighter, cambia la red a **Test Net**.
> 5. Si Freighter muestra un botón **Fund with Friendbot**, haz clic. Recibirás 10.000 XLM de prueba. Si no aparece, no te preocupes: lo fondeamos al empezar la llamada.
>
> **¿Te conectas desde el celular?** Sáltate los pasos anteriores. Configuramos juntos una billetera de prueba en los primeros minutos. Conéctate por Wi-Fi, con batería cargada y la app de la videollamada instalada para compartir la pantalla del celular.
>
> ¿Preguntas o necesitas reprogramar? {CONTACT}

**PT-BR**
> Obrigado(a) por se inscrever! Sua sessão: **{DATA, HORA, FUSO}**, link da videochamada: {LINK}.
>
> **Antes da chamada (computador, ~10 min):**
> 1. Crie um **novo perfil do navegador** (Chrome ou Brave: ícone de perfil → *Adicionar*), para que suas carteiras e saldos reais nunca apareçam na tela.
> 2. Nesse perfil, instale a extensão **Freighter** em freighter.app.
> 3. Crie uma carteira **nova**. Ela é só para este teste. Guarde a frase de recuperação só para você: **nunca a compartilhe com ninguém, nem com a gente. Nunca vamos pedi-la.**
> 4. Nas configurações da Freighter, mude a rede para **Test Net**.
> 5. Se a Freighter mostrar um botão **Fund with Friendbot**, clique nele. Você recebe 10.000 XLM de teste. Se não aparecer, tudo bem: a gente financia no começo da chamada.
>
> **Vai participar pelo celular?** Pule os passos acima. Vamos configurar uma carteira de teste juntos nos primeiros minutos. Esteja no Wi-Fi, com bateria carregada e com o app da videochamada instalado para compartilhar a tela do celular.
>
> Dúvidas ou precisa remarcar? {CONTACT}

## 4. Consent

Send this with the confirmation, and read the short version aloud at the start
(facilitator guide §1). Verbal consent is captured on the recording, or in the
notes if the session isn't recorded.

**EN**
> **Taking part in Turbolong user testing**
> - **What happens:** a 60-minute video call. You'll try some tasks in the Turbolong app and think aloud while you do.
> - **No financial risk:** everything uses Stellar's test network; test tokens have no value. We will never ask for your secret key or recovery phrase.
> - **Recording:** if you agree, we record your screen and voice. Only the research team sees it. It's stored privately and deleted 90 days after our report is final.
> - **What we publish:** scores and notes under a code (like "P04"), and short anonymous quotes. Never your name, email, wallet address or face.
> - **Your choice:** taking part is voluntary. You can skip any task, stop at any time, or ask us later to delete your data: {CONTACT}.
> - **Thank-you:** {INCENTIVE}, paid after the session whatever happens in it.

**ES**
> **Participación en las pruebas de usuario de Turbolong**
> - **Qué pasa:** una videollamada de 60 minutos. Vas a intentar algunas tareas en la app Turbolong y pensar en voz alta mientras lo haces.
> - **Sin riesgo financiero:** todo usa la red de prueba de Stellar; los tokens de prueba no tienen valor. Nunca te vamos a pedir tu clave secreta ni tu frase de recuperación.
> - **Grabación:** si estás de acuerdo, grabamos tu pantalla y tu voz. Solo la ve el equipo de investigación. Se guarda de forma privada y se borra 90 días después de terminar nuestro informe.
> - **Qué publicamos:** puntajes y notas bajo un código (como "P04") y frases cortas anónimas. Nunca tu nombre, email, dirección de billetera ni tu cara.
> - **Tú decides:** participar es voluntario. Puedes saltar cualquier tarea, parar en cualquier momento o pedirnos después que borremos tus datos: {CONTACT}.
> - **Agradecimiento:** {INCENTIVE}, que se paga después de la sesión pase lo que pase en ella.

**PT-BR**
> **Participação nos testes de usuário do Turbolong**
> - **O que acontece:** uma videochamada de 60 minutos. Você vai tentar algumas tarefas no app Turbolong e pensar em voz alta enquanto faz.
> - **Sem risco financeiro:** tudo usa a rede de teste da Stellar; os tokens de teste não têm valor. Nunca vamos pedir sua chave secreta nem sua frase de recuperação.
> - **Gravação:** se você concordar, gravamos sua tela e sua voz. Só a equipe de pesquisa vê. Fica guardada de forma privada e é apagada 90 dias depois que nosso relatório for finalizado.
> - **O que publicamos:** notas e pontuações sob um código (como "P04") e frases curtas anônimas. Nunca seu nome, e-mail, endereço de carteira nem seu rosto.
> - **Você decide:** participar é voluntário. Você pode pular qualquer tarefa, parar a qualquer momento ou pedir depois que apaguemos seus dados: {CONTACT}.
> - **Agradecimento:** {INCENTIVE}, pago depois da sessão, aconteça o que acontecer nela.
