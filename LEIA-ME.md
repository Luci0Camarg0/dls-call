# DLS Call

Call de voz com os amigos e transmissão de tela em 720p. Funciona pelo site e pelo app `.exe`.

## Como funciona (em português claro)

- **O servidor só apresenta os amigos uns aos outros.** Ele é minúsculo e roda de graça.
- **A voz e a tela vão direto do seu PC para o PC do amigo** (peer-to-peer). Não passam pelo servidor, então ele não precisa de internet boa nem de máquina forte.
- **A tela só é enviada para quem clicou em "Assistir".** Se ninguém está assistindo, você não gasta internet com isso.
- Os **códigos de convite não expiram** e continuam valendo mesmo se o servidor reiniciar.
- Cabem até **8 pessoas** por call. Isso é pensado para um grupo de amigos.

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

1. Abra o DLS Call e digite seu nome.
2. **Criar um convite** gera um código (ex.: `K7PQ-M2XA`) e já te coloca na call. Clique no código para copiar e mande para os amigos.
3. Os amigos colam o código e clicam em **Entrar na call**.
4. **Compartilhar tela**: escolha a tela ou janela e a fluidez (30 fps leve / 60 fps), depois clique em **Ao vivo**.
   - "Transmitir som do PC" manda o áudio do jogo/vídeo. **Use fone**, senão seus amigos escutam o eco da própria voz.
5. Quem quiser ver clica em **Assistir**. Clique no vídeo para ampliar, duplo clique para tela cheia.
6. Clique no nome de um amigo na lista para ajustar o volume dele.
7. Engrenagem: escolher o microfone e ligar/desligar a redução de ruído.

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
    server.js        convites e "apresentação" entre os amigos
    public/          a interface (HTML, CSS, JS)
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
