# Transfer

MVP minimo para transferir arquivos diretamente entre dois navegadores usando WebRTC DataChannel.

O servidor Node faz apenas:

- servir a pagina web;
- criar/entrar em sessoes por codigo;
- repassar sinalizacao WebRTC via WebSocket.

Os arquivos nao sao enviados para o servidor.

No recebimento, o app usa a File System Access API quando disponivel. Assim o arquivo
e gravado direto no disco em vez de ficar inteiro na memoria. Em navegadores sem essa
API, ele cai para o modo compativel e monta o arquivo em memoria no final.

Cada chunk enviado pelo DataChannel carrega um SHA-256. O receptor calcula o hash
do chunk recebido antes de gravar, interrompendo a transferencia se houver divergencia.
Transferencias em andamento podem ser canceladas por qualquer participante.
Tambem e possivel selecionar multiplos arquivos; eles entram em fila e sao enviados
um por vez pelo mesmo canal.
Durante uma transferencia, qualquer participante pode pausar e retomar o fluxo.

## Rodar

O frontend e o backend rodam separadamente durante o desenvolvimento. Em duas
janelas, rode:

```bash
npm run dev:backend
npm run dev:frontend
```

O backend fica em `http://localhost:3000` e o frontend Vite em
`http://localhost:5173`. Abra o endereco do Vite em dois navegadores ou
dispositivos na mesma rede.

Cada parte tambem pode ser iniciada dentro do proprio diretorio:

```bash
cd backend
npm run dev

cd frontend
npm run dev
```

Para gerar o build do front:

```bash
npm run build
npm run start
```

O `build` gera o frontend em `dist/`. Depois, `npm run start` inicia o backend
servindo esse build.

## TURN opcional

Por padrao o app usa apenas STUN publico. Para melhorar conexoes fora da rede local
ou em NATs restritos, configure um servidor TURN:

```bash
TURN_URLS=turn:turn.example.com:3478 TURN_USERNAME=user TURN_CREDENTIAL=pass npm run dev
```

`TURN_URLS` aceita uma lista separada por virgula, por exemplo
`turn:host:3478,turns:host:5349`.

## Expiracao de sessao

As sessoes ficam em memoria, acabam automaticamente quando todos desconectam e
tambem expiram por tempo. O padrao e 30 minutos:

```bash
SESSION_TTL_MS=1800000 npm run dev
```

## Estrutura

```text
backend/server.ts  # HTTP, WebSocket e sinalizacao WebRTC
frontend/src/       # frontend TypeScript modularizado
frontend/package.json
backend/package.json
frontend/index.html
frontend/styles.css
```

O backend expõe apenas a configuracao em `/config.json` e a sinalizacao em `/ws`.
O Vite compila o frontend para `dist/`, que pode ser servido pelo backend em
producao com `npm run build` e `npm run start`.
