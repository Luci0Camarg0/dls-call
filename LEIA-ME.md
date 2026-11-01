# DLS Call

Call de voz com os amigos e transmissão de tela em 720p. Funciona pelo site e pelo app `.exe`.

## Como funciona (em português claro)

- **O servidor guarda contas, servidores e mensagens, e apresenta os amigos uns aos outros.** Ele é pequeno e roda de graça.
- **A voz e a tela vão direto do seu PC para o PC do amigo** (peer-to-peer). Não passam pelo servidor, então ele não precisa de internet boa nem de máquina forte.
- **A tela só é enviada para quem clicou em "Assistir".** Se ninguém está assistindo, você não gasta internet com isso.
- Cada servidor tem um **código de convite fixo**: entrou uma vez, fica na sua conta.
- Cabem até **10 pessoas** por call. Isso é pensado para um grupo de amigos.

## Passo 1: colocar o servidor no ar (grátis, uns 10 minutos)

Vamos usar o **Render.com**, que tem plano gratuito e entrega o site com `https://`, que é obrigatório para o microfone funcionar.

1. Crie uma conta em **https://github.com** (é onde os arquivos ficam guardados).
2. No GitHub, clique em **New repository**, dê o nome `dls-call` e clique em **Create repository**.
3. Na página do repositório, clique em **uploading an existing file** e **arraste o conteúdo da pasta `dls-call`**
   (as pastas `server` e `desktop` e os arquivos `render.yaml`, `.gitignore` etc.).
   ⚠️ **Não envie** as pastas `node_modules` nem `dist`, porque são grandes e o servidor não precisa delas.
   Clique em **Commit changes**.
4. Crie uma conta em **https://render.com** (dá para entrar com a conta do GitHub).
5. No Render, clique em **New → Blueprint**, escolha o repositório `dls-call` e clique em **Apply**.
   O Render lê o arquivo `render.yaml` e configura tudo sozinho.
6. Espere uns 2 a 3 minutos. Vai aparecer um endereço parecido com **`https://dls-call.onrender.com`**.
   Abra o endereço no navegador. Se aparecer a tela do DLS Call, está no ar! 🎉

> **Sobre o plano grátis:** se ninguém usar por 15 minutos, o servidor "dorme". Quando alguém abrir de novo,
> ele demora **até 1 minuto** para acordar (o app mostra "Acordando o servidor…"). Depois disso fica normal.
> Durante a call ele fica acordado.

## Passo 2: gerar o `.exe` com o endereço do seu servidor

1. Dê dois cliques em **`gerar-exe.bat`**.
2. Cole o endereço do Render (ex.: `https://dls-call.onrender.com`) e aperte Enter.
3. No final, abre a pasta `desktop\dist` com dois arquivos:
   - **`DLS-Call.exe`**: abre direto, sem instalar (mais prático para mandar para os amigos).
   - **`DLS-Call-Instalador.exe`**: instala e cria atalho na área de trabalho.
4. Mande um deles para os amigos (por Google Drive, WeTransfer etc., porque tem ~100 MB).

> O Windows pode mostrar **"O Windows protegeu o computador"** porque o app não tem assinatura digital paga.
> É só clicar em **Mais informações → Executar assim mesmo**.

**Trocar o servidor sem gerar de novo:** crie um arquivo `servidor.txt` na mesma pasta do `.exe` com o endereço dentro.

**Sem .exe:** os amigos também podem usar direto pelo navegador (Chrome/Edge), abrindo o endereço do servidor.

## Usando

1. Abra o DLS Call e **crie uma conta** (usuário + senha). Anote a senha: não dá para recuperar.
   Nas próximas vezes o app já abre logado.
2. No **+** da barra da esquerda: **crie um servidor** ou **entre em um com o código de convite** (ex.: `K7PQ-M2XA`).
   O servidor fica salvo na sua conta, como no Discord. O código fica na engrenagem ao lado do nome do servidor.
3. **#chat**: mensagens ficam salvas. Enter manda, Shift+Enter pula linha. Link de imagem/GIF aparece direto.
4. **🔊 Geral**: entra na call. Dá para ver quem está na call mesmo sem entrar.
5. **Compartilhar tela**: escolha a tela ou janela e a fluidez (30 fps leve / 60 fps), depois clique em **Ao vivo**.
   "Transmitir som do PC" manda o áudio do jogo/vídeo (no `.exe`, a voz dos amigos fica de fora, sem eco).
6. Quem quiser ver clica em **Assistir**. Clique no vídeo para ampliar, duplo clique para tela cheia.
7. **Ouvir junto**: cole um link do YouTube e toca para todos, sincronizado.
8. **Soundpad**: sons de até 10 s do servidor. Clique no som ou defina uma tecla (F1–F12, teclado numérico ou Ctrl/Alt/Shift + tecla).
   No `.exe`, a tecla funciona mesmo com o jogo aberto, enquanto você estiver na call.
9. **Engrenagem de baixo** (configurações):
   - **Meu perfil**: nome, foto (imagem ou GIF) e banner (imagem, GIF ou cor).
   - **Aparência**: wallpaper com desfoque e escurecimento (fica salvo na conta).
   - **Voz e áudio**: microfone, saída de som e redução de ruído (ficam salvos no PC).
10. Clique no nome de um amigo na call para ajustar o volume dele, ou na lista de membros para ver o perfil.

**Onde os dados ficam:** contas, servidores, mensagens, fotos e sons ficam no banco de dados grátis do **Neon**
(variável `DATABASE_URL` no Render). Sem ela, o servidor usa um banco temporário que some quando reinicia.

## Se algum amigo não conseguir conectar

Na maioria das internets de casa a conexão direta funciona. Em algumas redes (internet de celular, empresas, alguns provedores),
o amigo aparece "apagado" na lista e não ouve ninguém. A solução é um servidor **TURN** (um "repetidor"), e a Cloudflare dá um de graça:

1. Crie conta em **https://dash.cloudflare.com** → **Realtime → TURN Server** → **Create**.
2. Copie o **Turn Token ID** e o **API Token**.
3. No Render, abra seu serviço → **Environment** → adicione:
   - `CF_TURN_KEY_ID` = o Token ID
   - `CF_TURN_API_TOKEN` = o API Token
4. Salve. O Render reinicia sozinho e pronto.

## Testar no seu PC antes de publicar

Dê dois cliques em **`testar-local.bat`**. Abre `http://localhost:3000` no navegador.
Abra duas abas para simular duas pessoas.

## Estrutura

```
dls-call/
  server/            servidor + site (é isso que vai para o Render)
    server.js        contas, servidores, chat, arquivos e "apresentação" entre os amigos
    db.js            banco de dados (Neon na internet, PGlite no seu PC)
    public/          a interface: core.js (base), app.js (telas), chat.js, voice.js (call e tela),
                     music.js (Ouvir junto), soundpad.js
  desktop/           app .exe (Electron)
    main.js          janela, seletor de telas, espera o servidor acordar
    config.json      endereço do servidor (o gerar-exe.bat preenche)
  render.yaml        configuração automática do Render
  gerar-exe.bat      gera o .exe
  testar-local.bat   roda o servidor no seu PC
```

## Detalhes técnicos (para curiosos)

- Tela: captura limitada a 1280×720, codec H264 (usa aceleração da placa de vídeo quando tem),
  2,5 Mbps a 30 fps ou 4,5 Mbps a 60 fps, priorizando manter os 720p (se a internet apertar, cai o fps, não a resolução).
- Voz: Opus com cancelamento de eco, redução de ruído e controle de volume automático.
- Cada pessoa se conecta com cada outra (malha). Quem transmite envia uma cópia da tela para cada pessoa que está assistindo.
  Com 3 assistindo a 30 fps, são ~7,5 Mbps de upload.
