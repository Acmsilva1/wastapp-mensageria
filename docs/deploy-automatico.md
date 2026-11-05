# Deploy automático

Este projeto é publicado na VPS de forma automática pelo host, sem pipeline externo.

## Como funciona

- Um timer do systemd (`vps-deploy.timer`) verifica o repositório a cada 2 minutos.
- Se houver commit novo em `feat/safety-reset`, a VPS executa: `git checkout` → `docker compose build` → `up -d`.
- Ao final roda um health check (painel em `127.0.0.1:3338` e worker em execução).
- Se o build ou o health check falhar, o deploy volta sozinho para o commit anterior.

## Fluxo de trabalho

1. Editar os arquivos na pasta local.
2. `git commit` e `git push` em `feat/safety-reset`.
3. Em até 2 minutos a VPS atualiza sozinha.

## Operação

```bash
/opt/deploy/status.sh                    # commit em produção
journalctl -u vps-deploy -f              # acompanhar
/opt/deploy/deploy-one.sh mensageria     # forçar agora
```

## Observações

- O `.env` da VPS não é versionado nem sobrescrito pelo deploy.
- Alterações feitas diretamente na VPS são descartadas no próximo deploy.
- A branch de produção é `feat/safety-reset`; pushes em outras branches não disparam deploy.
