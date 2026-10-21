# Facilitator Guide — Turbolong User Testing

The session script for the programme in [`README.md`](README.md). Read the
participant-facing lines (EN / ES / PT-BR) **word for word**, so every session
gets the same prompt. Everything else is for the facilitator and note-taker
only. Task IDs match [`protocol.json`](protocol.json) and the session record
template.

> ES and PT-BR text: have a native speaker read it aloud once during the pilot
> and fix anything that sounds unnatural *before* session 1. After that, the
> wording is frozen.

---

## Before the session (facilitator)

- [ ] **Build.** Note the commit SHA of the deployed app. It goes in the record's
      `build` field.
- [ ] **Testnet check, 30 minutes before.** Using your own testnet wallet, open the
      app on Testnet. Confirm that:
      - a 1,000 XLM loop previews with a Health Factor above 1.1 and no liquidity
        error;
      - the *Leveraged XLM (Testnet)* vault accepts a deposit;
      - ⚙ → *Status page* shows the services up.
      If testnet is down, reschedule rather than run a degraded session.
- [ ] **Participant setup** ([`recruitment.md`](recruitment.md) § Setup kit) is
      confirmed:
      - a fresh browser profile;
      - a **new** wallet on Testnet;
      - 10,000 test XLM.
      Fallback if they're unfunded: ask for their **public** address (G…) in
      the chat and run `curl "https://friendbot.stellar.org/?addr=G…"`. Never
      write the address into the notes.
- [ ] **Note-taker** has a copy of `sessions/_template.json` saved as the next
      `P<NN>`, a stopwatch, and these task IDs to hand.
- [ ] **Language.** The script for the participant's language is open.

## Running tasks (both roles)

**Prompts:**

- Read the prompt, then say: **"Tell me when you think you're done."**
- Never name a UI label the task is testing. Say "the hands-off option", not
  "Vault"; "take some out", not "Remove Funds".

**Questions from the participant:**

- Answer with a question: "What would you expect?" / "What do you think?"
- Let silence run 10–15 seconds before you prompt.

**Assist ladder** (README § Scoring):

1. A neutral prompt is free.
2. The card's **scripted hint** counts as an assist, so the score is at most 1.
3. Telling them, or doing it for them, scores **0**.

**Timer:** starts when the prompt ends. It stops at the success state, when they
give up, or at the time limit. At the limit, say: "Thanks, that's really useful.
Let's move on."

**SEQ** after every task, read aloud:

- **EN:** "Overall, how difficult or easy was that task? 1 is very difficult, 7 is very easy."
- **ES:** "En general, ¿qué tan difícil o fácil fue esa tarea? 1 es muy difícil, 7 es muy fácil."
- **PT-BR:** "No geral, quão difícil ou fácil foi essa tarefa? 1 é muito difícil, 7 é muito fácil."

**Recovering state.** Later tasks need the state earlier ones leave behind:
connected (O1) → position (D2) → vault deposit (D3). If a core task fails, walk
them through it (level 3, score 0) so the session can continue. Say: "Let me show
you one way, so we can keep going."

**What the note-taker records:**

- per task: `score`, `timeSec`, `seq`, `assists`;
- every problem, with a recording timestamp and a short verbatim quote. Keep
  the original language, and add an English gist at triage;
- for D2, the **leverage and Health Factor they chose**, and what they said about
  why.

---

## 1. Intro and consent — 5 min

**EN:**
> Thanks for joining. Today we're testing Turbolong, an app for leveraged positions on Stellar. We're testing the app, not you. There are no wrong answers. If something is confusing, that's exactly what we need to find. Please think aloud: tell me what you're looking at, what you expect, and anything that surprises you. During the tasks I may not answer questions, because we want to see what you'd do on your own. I'll answer everything at the end. Everything today happens on Stellar's **test network**, so no real money is involved. We will **never** ask for your secret key or recovery phrase. Is it OK if we record the screen and audio? Only our team sees it, and it's deleted after 90 days. You can stop at any time.

**ES:**
> Gracias por participar. Hoy estamos probando Turbolong, una app para posiciones apalancadas en Stellar. Estamos evaluando la app, no a ti. No hay respuestas incorrectas: si algo te confunde, eso es justamente lo que necesitamos encontrar. Por favor, piensa en voz alta: cuéntame qué estás mirando, qué esperas que pase y qué te sorprende. Durante las tareas puede que no responda preguntas, porque queremos ver qué harías por tu cuenta; al final respondo todo. Todo lo de hoy pasa en la **red de prueba** de Stellar, así que no hay dinero real en juego. **Nunca** te vamos a pedir tu clave secreta ni tu frase de recuperación. ¿Está bien si grabamos la pantalla y el audio? Solo lo ve nuestro equipo y se borra a los 90 días. Puedes parar cuando quieras.

**PT-BR:**
> Obrigado(a) por participar. Hoje estamos testando o Turbolong, um app para posições alavancadas na Stellar. Estamos avaliando o app, não você. Não existem respostas erradas: se algo for confuso, é exatamente isso que precisamos descobrir. Por favor, pense em voz alta: conte o que você está vendo, o que espera que aconteça e o que te surpreende. Durante as tarefas talvez eu não responda perguntas, porque queremos ver o que você faria sozinho(a); no final eu respondo tudo. Tudo hoje acontece na **rede de teste** da Stellar, então não há dinheiro de verdade envolvido. **Nunca** vamos pedir sua chave secreta nem sua frase de recuperação. Tudo bem se gravarmos a tela e o áudio? Só a nossa equipe vê, e a gravação é apagada após 90 dias. Você pode parar quando quiser.

Start recording only after a clear "yes". If they decline, continue without
recording and set nothing special in the record. The notes are the record.

## 2. Warm-up — 3 min (not scored)

| EN | ES | PT-BR |
|---|---|---|
| What do you use crypto for today? Which wallets and apps? | ¿Para qué usas cripto hoy? ¿Qué billeteras y apps usas? | Para que você usa cripto hoje? Quais carteiras e apps? |
| Have you ever borrowed against crypto or used leverage? Tell me about the last time. | ¿Alguna vez pediste prestado usando cripto como garantía o usaste apalancamiento? Cuéntame la última vez. | Você já pegou empréstimo usando cripto como garantia ou usou alavancagem? Me conte a última vez. |
| *(Share the app link.)* Open this link. Before you click anything: what do you think this app does, and who is it for? | *(Comparte el link de la app.)* Abre este link. Antes de hacer clic en nada: ¿qué crees que hace esta app y para quién es? | *(Compartilhe o link do app.)* Abra este link. Antes de clicar em qualquer coisa: o que você acha que este app faz e para quem ele é? |

Note whether they **read** the *Before you start* risk disclaimer or tick it
straight away. It's a watch item, not a task.

---

## 3. Onboard

### O1 — Connect the test wallet · core · 5 min

**Starting state:** the app is freshly opened in their test profile. **The app
defaults to Mainnet; their wallet is on Testnet.**

| EN | ES | PT-BR |
|---|---|---|
| Your test wallet is already set up on Stellar's test network and has 10,000 test XLM. Connect it to Turbolong so you could start using it. | Tu billetera de prueba ya está configurada en la red de prueba de Stellar y tiene 10.000 XLM de prueba. Conéctala a Turbolong para poder empezar a usarla. | Sua carteira de teste já está configurada na rede de teste da Stellar e tem 10.000 XLM de teste. Conecte-a ao Turbolong para poder começar a usar. |

- **2:** the network pill reads **Testnet**, the wallet pill shows their address,
  **and** they can see their XLM balance (for example *Balance: … XLM* on the
  Trade deposit card).
- **1:** reached that state only after the hint, or connected but needed the
  hint to find their balance.
- **0:** not connected and on Testnet within 5 minutes.
- **Hint:**
  - **EN** "Is there anything on screen that tells you which network the app is using?"
  - **ES** "¿Hay algo en la pantalla que te diga qué red está usando la app?"
  - **PT-BR** "Tem algo na tela que mostre qual rede o app está usando?"
- **Watch:**
  - Does the *Network mismatch* message make sense to them? What do they do after
    the app disconnects them?
  - Do they find the Mainnet/Testnet pill?
  - Does the screen **still say "Connect your wallet"** after they connected?
    (known stale-screen issue)
  - Do they click the testnet **Fund wallet** button? (known: it does nothing)
  - Which wallet do they pick, and why?

### O2 — Switch the app to their language · stretch · 2 min

Run this only if the app is **not** already in their language. Otherwise record
`score: null`, `skipReason: "already in language"`.

| EN | ES | PT-BR |
|---|---|---|
| If the app isn't in the language you'd prefer, change it. | Si la app no está en el idioma que prefieres, cámbialo. | Se o app não estiver no idioma que você prefere, mude. |

- **2:** the navigation is in their language.
- **1:** done after the hint.
- **0:** not found.
- **Hint:**
  - **EN** "Where do you usually find settings in an app?"
  - **ES** "¿Dónde sueles encontrar la configuración en una app?"
  - **PT-BR** "Onde você costuma encontrar as configurações em um app?"
- **Watch:**
  - Does the screen they're on stay in English until they navigate away?
    (known)
  - Which parts are still in English? Note every untranslated string they
    react to, for the whole session.

---

## 4. Deposit

### D1 — Find the best leveraged XLM yield · stretch · 4 min

| EN | ES | PT-BR |
|---|---|---|
| Before you put anything in: find where your XLM would earn the most with leverage. Which option would you pick, and why? | Antes de poner nada: busca dónde tus XLM ganarían más con apalancamiento. ¿Qué opción elegirías y por qué? | Antes de colocar qualquer coisa: encontre onde seus XLM renderiam mais com alavancagem. Qual opção você escolheria e por quê? |

- **2:** names a pool and a leverage, and justifies the choice with the **net**
  return (after borrow cost), not the base supply rate.
- **1:** picks an option but reasons from base APY or "the biggest number", or
  needed the hint.
- **0:** can't find a way to compare.
- **Hint:**
  - **EN** "Is there a place that shows several options side by side?"
  - **ES** "¿Hay algún lugar que muestre varias opciones lado a lado?"
  - **PT-BR** "Tem algum lugar que mostre várias opções lado a lado?"
- **Watch:**
  - Do they discover the Compare view?
  - How do they read *Net APY @x*?
  - Testnet history shows "building history…".
  - Do they try to click a row to open it? (no row → Trade link exists)

### D2 — Open a leveraged XLM position · core · 8 min

| EN | ES | PT-BR |
|---|---|---|
| Use 1,000 of your test XLM to open a leveraged position on XLM, at a level of risk you'd be comfortable with if this were your own money. Tell me what you're thinking as you choose. | Usa 1.000 de tus XLM de prueba para abrir una posición apalancada en XLM, con un nivel de riesgo con el que estarías cómodo/a si fuera tu propio dinero. Cuéntame qué piensas mientras eliges. | Use 1.000 dos seus XLM de teste para abrir uma posição alavancada em XLM, com um nível de risco com o qual você ficaria confortável se fosse seu próprio dinheiro. Conte o que está pensando enquanto escolhe. |

**When the *Review position* modal appears, interrupt before they confirm. Pause
the timer.**

| | EN | ES | PT-BR |
|---|---|---|---|
| **C1** | Before you confirm: what does the Health Factor on this screen tell you? What would happen if it reached 1.0? | Antes de confirmar: ¿qué te dice el Health Factor en esta pantalla? ¿Qué pasaría si llegara a 1,0? | Antes de confirmar: o que o Health Factor nesta tela te diz? O que aconteceria se ele chegasse a 1,0? |
| **C2** | If this were your own money, what could make you lose money with this position? | Si fuera tu propio dinero, ¿qué podría hacer que pierdas dinero con esta posición? | Se fosse seu próprio dinheiro, o que poderia fazer você perder dinheiro com essa posição? |
| *resume* | Thanks. Go ahead whenever you're ready. | Gracias. Sigue cuando quieras. | Obrigado(a). Pode continuar quando quiser. |

**Scoring C1 and C2:**

- **C1**
  - **correct:** collateral vs. debt, i.e. the safety margin, **and** at or
    below 1.0 the position can be liquidated and collateral lost.
  - **partial:** "lower is riskier" with no consequence.
  - **incorrect:** wrong or no idea, or thinks it's a return multiplier.
- **C2**
  - **correct:** at least one real driver:
    - borrow cost exceeding supply yield plus BLND, i.e. net APY turning
      negative;
    - Health Factor drifting toward 1;
    - BLND emissions dropping.
  - **partial:** only "the price goes down", with no mechanism. In a
    same-asset XLM loop, XLM's price barely moves the Health Factor; your USD
    value falls, but liquidation risk doesn't come from it.
  - **incorrect:** "nothing" or no idea.

**Scoring D2:**

- **2:** position confirmed on-chain with a 950–1,050 XLM deposit (the stepper
  reaches *Confirmed* and the position shows up).
- **1:** the amount is outside that range, or they needed the hint.
- **0:** no position after 8 minutes (time spent on C1/C2 excluded), or they
  abandon at signing.
- **Hint:**
  - **EN** "Is there a part of the app for opening a position?"
  - **ES** "¿Hay alguna parte de la app para abrir una posición?"
  - **PT-BR** "Tem alguma parte do app para abrir uma posição?"

**Watch:**

- **Leverage choice:**
  - how they use the slider zones (Conservative → Degen);
  - whether they see *Max x× at c_factor*;
  - whether they find Expert mode.
- **Warnings:**
  - do they read the negative-APY warning and the "loop runs atomically" caveat?
  - is the review checkbox read or just ticked?
- **Signing:**
  - the extra **Trustlines** signature: is it expected?
  - two to three wallet pop-ups;
  - the stepper hides after 3 seconds.
- **Costs:** do they look for fees? None are shown.
- **Errors:** raw error text.

### D3 — Deposit into the managed vault · core · 4 min

| EN | ES | PT-BR |
|---|---|---|
| Now put 500 test XLM into the hands-off option, where the position is managed for you instead of by you. | Ahora deposita 500 XLM de prueba en la opción automática, donde la posición la gestionan por ti en lugar de gestionarla tú. | Agora coloque 500 XLM de teste na opção automática, em que a posição é gerenciada para você, em vez de você mesmo gerenciar. |

- **2:** deposit of 450–550 XLM into *Leveraged XLM (Testnet)* confirmed (toast:
  *Deposited … XLM*).
- **1:** wrong amount, or needed the hint.
- **0:** no deposit within 4 minutes.
- **Hint:**
  - **EN** "Look at the tabs. Which one sounds closest to that?"
  - **ES** "Mira las pestañas. ¿Cuál suena más parecida a eso?"
  - **PT-BR** "Olhe as abas. Qual parece mais próxima disso?"
- **Watch:**
  - Do they understand "SEP-41 receipt token" and "Auto-rebalance"?
  - Do they understand the leverage is fixed by the vault?
  - *Projected HF before → after*.
  - Raw "Deposit failed: {…}" errors.
  - No expected-return preview for their deposit.

---

## 5. Monitor

### M1 — Read value, earnings and safety · core · 4 min

| EN | ES | PT-BR |
|---|---|---|
| Imagine it's a week from now and you open Turbolong again. Show me how your leveraged position is doing: how much is it worth, how much is it earning, and how safe is it? | Imagina que pasó una semana y vuelves a abrir Turbolong. Muéstrame cómo va tu posición apalancada: ¿cuánto vale, cuánto está ganando y qué tan segura está? | Imagine que se passou uma semana e você abre o Turbolong de novo. Me mostre como está sua posição alavancada: quanto ela vale, quanto está rendendo e quão segura ela está? |

- **2:** states the position's **equity**, **net APY** and **Health Factor**, all
  three matching the screen (Dashboard pool card or Trade *Your Position*).
- **1:** gets two of the three, reads a base rate as the earnings, or needed the
  hint.
- **0:** can't find the position, or misreads two or more.
- **Hint:**
  - **EN** "Where would you expect a summary of everything you have?"
  - **ES** "¿Dónde esperarías ver un resumen de todo lo que tienes?"
  - **PT-BR** "Onde você esperaria ver um resumo de tudo o que você tem?"
- **Watch:**
  - Which screen they go to first.
  - How they read the *Safe / Caution / High risk* labels.
  - How they read *Liquidation price* shown as "−N% move".
  - Missing profit/loss or entry value: do they ask for it?
  - *Activity* entries all labelled "Rebalanced".
  - A stale Dashboard after reconnecting.

### M2 — Check how healthy the vault is · core · 3 min

| EN | ES | PT-BR |
|---|---|---|
| Now your deposit in the hands-off option: how healthy is it right now? | Ahora tu depósito en la opción automática: ¿qué tan saludable está ahora mismo? | Agora seu depósito na opção automática: quão saudável ele está agora? |

Then **C3**, after they answer:

| EN | ES | PT-BR |
|---|---|---|
| What happens if it gets risky? Would you need to do anything? | ¿Qué pasa si se vuelve riesgoso? ¿Tendrías que hacer algo? | O que acontece se ele ficar arriscado? Você precisaria fazer alguma coisa? |

- **M2:**
  - **2:** states the vault's strategy health (*Strategy Health … ·
    keeper-protected* on the Dashboard, or the strategy HF bar in Vault).
  - **1:** reads only their equity or APY, or needed the hint.
  - **0:** can't find it.
  - **Hint:**
    - **EN** "Is there a part of the app that's specifically about that option?"
    - **ES** "¿Hay alguna parte de la app específica para esa opción?"
    - **PT-BR** "Tem alguma parte do app específica para essa opção?"
- **C3:**
  - **correct:** an automatic keeper partially unwinds when health drops into the
    orange zone, so they don't need to act. The exact threshold isn't required;
    it's on the vault's Strategy Position card (1.20 in the testnet XLM config,
    refreshed from the contract at load).
  - **partial:** "it's automatic", with no idea what happens.
  - **incorrect:** thinks they must act, or no idea.
- **Watch:**
  - The Dashboard vault card shows **Net APY +0.0%** (known): does it worry
    them?
  - What do "keeper-protected" and "orange zone" mean to them?

### M3 — Set up a near-liquidation alert · core · 5 min · **mainnet**

**Setup** (not timed, not scored):

- **EN** "For this next one, please switch the app to Mainnet using the network switch at the top. Your wallet doesn't need to be connected."
- **ES** "Para la siguiente, cambia la app a Mainnet con el selector de red de arriba. No hace falta que tu billetera esté conectada."
- **PT-BR** "Para a próxima, mude o app para Mainnet usando o seletor de rede no topo. Não precisa conectar a carteira."

| EN | ES | PT-BR |
|---|---|---|
| You won't be checking Turbolong every day. Set things up so you'd get a warning before a position like the one you opened gets close to liquidation. You can use a throwaway email, or stop just before the final button if you'd rather not enter one. | No vas a revisar Turbolong todos los días. Configúralo para recibir un aviso antes de que una posición como la que abriste esté cerca de ser liquidada. Puedes usar un email descartable, o parar justo antes del botón final si prefieres no poner uno. | Você não vai olhar o Turbolong todo dia. Configure para receber um aviso antes que uma posição como a que você abriu fique perto de ser liquidada. Pode usar um e-mail descartável, ou parar logo antes do botão final se preferir não colocar um. |

Then **C4:**

| EN | ES | PT-BR |
|---|---|---|
| What exactly will that alert be watching? When would you expect to get it? | ¿Qué es exactamente lo que va a vigilar esa alerta? ¿Cuándo esperarías recibirla? | O que exatamente esse alerta vai monitorar? Quando você esperaria recebê-lo? |

- **M3:**
  - **2:** the alert form has a Health Factor condition (*Health factor below
    threshold* with a threshold above 1, or *Liquidation imminent*), asset
    **XLM**, and the leverage bracket closest to their D2 leverage. It is
    submitted, or the form is correctly filled when they stop. Mainnet pools
    differ from testnet ones, so any pool is accepted.
  - **1:** only the APY condition, a bracket far from their leverage, or needed
    the hint.
  - **0:** alerts not found within 5 minutes.
  - **Hint:**
    - **EN** "If an app wanted to send you notifications, where would you look to turn that on?"
    - **ES** "Si una app quisiera enviarte notificaciones, ¿dónde buscarías para activarlas?"
    - **PT-BR** "Se um app quisesse te mandar notificações, onde você procuraria para ativar?"
- **C4:**
  - **correct:** it watches the chosen pool/asset at the chosen leverage
    bracket, **not** their wallet's actual position.
  - **partial:** unsure, or says "probably the pool rates".
  - **incorrect:** "my position" or "my wallet". This is the expected
    misconception, so record their exact words.
- **Watch:**
  - Where do they look first? The only entry point is ⚙ → *Set up alerts*;
    note every place they try before that.
  - The leverage brackets (2/3/5/8/10×) vs. the leverage they actually chose.
  - What does "HF threshold (> 1)" mean to them?
  - If they verify the email: the confirmation page talks about **negative
    APY** even for a Health Factor alert (known).

**Afterwards** (not timed):

- **EN** "Thanks. Please switch back to Testnet and reconnect your wallet."
- **ES** "Gracias. Vuelve a Testnet y conecta de nuevo tu billetera."
- **PT-BR** "Obrigado(a). Volte para Testnet e conecte sua carteira de novo."

### M4 — Make the position safer without closing · stretch · 3 min

| EN | ES | PT-BR |
|---|---|---|
| Say you've decided this position is riskier than you'd like. Make it safer, without closing it. | Digamos que decidiste que esta posición es más riesgosa de lo que te gustaría. Hazla más segura, sin cerrarla. | Digamos que você decidiu que essa posição está mais arriscada do que gostaria. Deixe-a mais segura, sem fechar. |

- **2:** leverage decreased and confirmed, so the Health Factor is higher.
- **1:** done after the hint.
- **0:** not found. **Also 0** if they add funds or remove funds believing it's
  now safer. Both keep leverage and Health Factor unchanged, so it's a *false
  success*: score 0, and log it.
- **Hint:**
  - **EN** "Is there a way to change a position you already have?"
  - **ES** "¿Hay alguna forma de cambiar una posición que ya tienes?"
  - **PT-BR** "Tem algum jeito de mudar uma posição que você já tem?"

### M5 — Check whether Turbolong itself is down · stretch · 2 min

| EN | ES | PT-BR |
|---|---|---|
| Imagine the numbers stopped updating and you're not sure if it's your internet or Turbolong. How would you find out whether Turbolong is having a problem? | Imagina que los números dejaron de actualizarse y no sabes si es tu internet o Turbolong. ¿Cómo averiguarías si Turbolong tiene un problema? | Imagine que os números pararam de atualizar e você não sabe se é sua internet ou o Turbolong. Como você descobriria se o Turbolong está com problema? |

- **2:** reaches the in-app Status page (⚙ → *Status page*).
- **1:** reaches it after the hint.
- **0:** not found.
- **Hint:**
  - **EN** "Have a look through the menus."
  - **ES** "Echa un vistazo a los menús."
  - **PT-BR** "Dá uma olhada nos menus."
- **Note** where they'd look outside the app (X/Twitter, Discord, Telegram).

---

## 6. Exit

### X1 — Take 300 XLM out, keep the position open · core · 4 min

| EN | ES | PT-BR |
|---|---|---|
| You need 300 XLM back in your wallet, but you want the rest of your leveraged position to keep running. Do that. | Necesitas recuperar 300 XLM en tu billetera, pero quieres que el resto de tu posición apalancada siga funcionando. Hazlo. | Você precisa de 300 XLM de volta na sua carteira, mas quer que o resto da sua posição alavancada continue funcionando. Faça isso. |

Then **C5:**

| EN | ES | PT-BR |
|---|---|---|
| What happened to your leverage and your Health Factor just now? | ¿Qué pasó con tu apalancamiento y tu Health Factor recién? | O que aconteceu com sua alavancagem e seu Health Factor agora há pouco? |

- **X1:**
  - **2:** 270–330 XLM withdrawn through *Remove Funds*, and the position is
    still open.
  - **1:** wrong amount, or needed the hint.
  - **0:** closed the whole position (wrong path), or nothing withdrawn within
    4 minutes. If they closed it, re-open a position for them (level 3) so X2
    can run.
  - **Hint:**
    - **EN** "Have a look at the options on your position."
    - **ES** "Mira las opciones de tu posición."
    - **PT-BR** "Dá uma olhada nas opções da sua posição."
- **C5:**
  - **correct:** both stayed the same.
  - **partial:** one right.
  - **incorrect:** thinks risk went up or down.
- **Watch:**
  - "principal" vs. "equity";
  - the 90% Max limit;
  - the "Use Close to exit fully" message.

### X2 — Close the position fully · core · 3 min

| EN | ES | PT-BR |
|---|---|---|
| Now close your leveraged position completely and get everything back into your wallet. | Ahora cierra tu posición apalancada por completo y recupera todo en tu billetera. | Agora feche sua posição alavancada por completo e traga tudo de volta para sua carteira. |

**When *Close this position?* appears, ask C6 before they confirm. Pause the timer.**

| EN | ES | PT-BR |
|---|---|---|
| Before you confirm: is there anything you'd lose by closing right now? | Antes de confirmar: ¿hay algo que perderías si cierras ahora mismo? | Antes de confirmar: tem algo que você perderia se fechasse agora? |

- **X2:**
  - **2:** close confirmed, either in one step or through the two-step
    fallback; the position is gone and their wallet XLM went up.
  - **1:** needed the hint.
  - **0:** not closed within 3 minutes.
  - **Hint:**
    - **EN** "Is there something that ends the position?"
    - **ES** "¿Hay algo que termine la posición?"
    - **PT-BR** "Tem algo que encerre a posição?"
- **C6:**
  - **correct:** unclaimed BLND rewards are forfeited unless they claim first.
  - **partial:** "rewards", but unsure.
  - **incorrect:** nothing, or no idea.
- **Watch:**
  - Do they check their wallet balance afterwards?
  - Does the two-step fallback toast confuse them?
  - The *View ↗* link opens the **mainnet** explorer (known).

### X3 — Withdraw everything from the vault · core · 3 min

| EN | ES | PT-BR |
|---|---|---|
| Last one: take all your money out of the hands-off option. | La última: saca todo tu dinero de la opción automática. | A última: tire todo o seu dinheiro da opção automática. |

- **2:** vault withdrawal confirmed, returning ≥ 99% of their vault equity. Max
  leaves 0.001 behind; note whether they notice.
- **1:** only part withdrawn, or needed the hint.
- **0:** nothing withdrawn within 3 minutes.
- **Hint:**
  - **EN** "Go back to where you put it in."
  - **ES** "Vuelve a donde lo depositaste."
  - **PT-BR** "Volte para onde você depositou."
- **Watch:**
  - Do they confuse shares and the underlying asset?
  - Is the ghost-style *Withdraw* button easy to see?
  - What do they make of the *Rebalance* button?
  - The *Sell receipt token* panel ("Not yet listed on Aquarius" for XLM): does
    it pull them off course?

---

## 7. Wrap-up — 7 min

### SUS

Share the questionnaire as a form or a doc in their language, so they can read
it, or read it aloud.

- **EN:** "Last part: ten short statements. For each one, tell me how much you agree, from 1 = strongly disagree to 5 = strongly agree. Don't think too long."
- **ES:** "Última parte: diez frases cortas. Para cada una, dime cuánto estás de acuerdo, de 1 = totalmente en desacuerdo a 5 = totalmente de acuerdo. No lo pienses demasiado."
- **PT-BR:** "Última parte: dez frases curtas. Para cada uma, diga o quanto você concorda, de 1 = discordo totalmente a 5 = concordo totalmente. Não pense muito."

| # | EN | ES | PT-BR |
|---|---|---|---|
| 1 | I think that I would like to use Turbolong frequently. | Creo que me gustaría usar Turbolong con frecuencia. | Acho que gostaria de usar o Turbolong com frequência. |
| 2 | I found Turbolong unnecessarily complex. | Encontré Turbolong innecesariamente complejo. | Achei o Turbolong desnecessariamente complexo. |
| 3 | I thought Turbolong was easy to use. | Pensé que Turbolong era fácil de usar. | Achei o Turbolong fácil de usar. |
| 4 | I think that I would need the support of a technical person to be able to use Turbolong. | Creo que necesitaría el apoyo de una persona técnica para poder usar Turbolong. | Acho que precisaria do apoio de uma pessoa técnica para conseguir usar o Turbolong. |
| 5 | I found the various functions in Turbolong were well integrated. | Encontré que las distintas funciones de Turbolong estaban bien integradas. | Achei que as várias funções do Turbolong estavam bem integradas. |
| 6 | I thought there was too much inconsistency in Turbolong. | Pensé que había demasiada inconsistencia en Turbolong. | Achei que havia muita inconsistência no Turbolong. |
| 7 | I would imagine that most people would learn to use Turbolong very quickly. | Imagino que la mayoría de las personas aprendería a usar Turbolong muy rápido. | Imagino que a maioria das pessoas aprenderia a usar o Turbolong muito rápido. |
| 8 | I found Turbolong very cumbersome to use. | Encontré Turbolong muy engorroso de usar. | Achei o Turbolong muito trabalhoso de usar. |
| 9 | I felt very confident using Turbolong. | Me sentí muy seguro/a usando Turbolong. | Eu me senti muito confiante usando o Turbolong. |
| 10 | I needed to learn a lot of things before I could get going with Turbolong. | Necesité aprender muchas cosas antes de poder empezar a usar Turbolong. | Precisei aprender muitas coisas antes de conseguir começar a usar o Turbolong. |

Record the answers in order as `sus: [a1, …, a10]`. The script does the scoring.

### Confidence and debrief

| | EN | ES | PT-BR |
|---|---|---|---|
| **Confidence** (1–7 → `confidence`) | On a scale of 1 to 7, how confident would you feel putting your own money into Turbolong? Why? | En una escala del 1 al 7, ¿qué tan seguro/a te sentirías poniendo tu propio dinero en Turbolong? ¿Por qué? | Numa escala de 1 a 7, quão confiante você se sentiria colocando seu próprio dinheiro no Turbolong? Por quê? |
| Debrief | What was the most confusing moment today? | ¿Cuál fue el momento más confuso de hoy? | Qual foi o momento mais confuso de hoje? |
| Debrief | If you could change one thing, what would it be? | Si pudieras cambiar una sola cosa, ¿cuál sería? | Se você pudesse mudar uma coisa, qual seria? |
| Debrief | Where you live, how would you normally get money into a wallet like this? | Donde vives, ¿cómo pondrías normalmente dinero en una billetera así? | Onde você mora, como você normalmente colocaria dinheiro numa carteira assim? |
| Debrief | Who would you recommend this to, if anyone? | ¿A quién se lo recomendarías, si a alguien? | Para quem você recomendaria isso, se para alguém? |
| Close | That's everything, thank you. Now I'm happy to answer any of your questions. | Eso es todo, ¡gracias! Ahora con gusto respondo tus preguntas. | É isso, obrigado(a)! Agora posso responder qualquer pergunta sua. |

Stop the recording. Confirm the payment details: their **mainnet** public
address for the thank-you payment, collected in the private sheet, never in the
repo.

---

## After the session

**Note-taker, within 24 hours:**

- [ ] File `docs/user-testing/sessions/P<NN>.json`:
  - `build` set to the commit SHA;
  - per-task `issues` left empty until triage.
- [ ] Validate the record: `npx tsx scripts/user_testing_report.ts --no-issues --stdout`.
- [ ] Move the recording and notes to the private drive and delete local copies.

**Facilitator:**

- [ ] Send the thank-you payment.
- [ ] If you saw a possible **S1**, flag it in the team channel today (README § 7).
- [ ] After every third session, run triage (README § 7).
