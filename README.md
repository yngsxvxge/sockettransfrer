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

## Rodar

```bash
npm run dev
```

Abra `http://localhost:3000` em dois navegadores ou dispositivos na mesma rede.

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
frontend/app.ts    # interface e transferencia via DataChannel
frontend/index.html
frontend/styles.css
```

O navegador continua carregando `/app.js`; o backend gera essa resposta a partir
de `frontend/app.ts` em tempo de execucao.
