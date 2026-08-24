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
