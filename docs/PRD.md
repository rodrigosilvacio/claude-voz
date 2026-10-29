# PRD: Nina, conselheira pessoal por voz no Telegram

| Campo | Valor |
| :---- | :---- |
| Owner | Rodrigo Silva (CIO, Nitro) |
| Usuário | Rodrigo Silva, único usuário |
| Status | Rascunho para validação |
| Data | 2026-10-29 |

---

## 1. Resumo executivo

Nina é uma conselheira pessoal, acessada por áudio ou texto no Telegram, que responde com voz. Ela existe para um único usuário, Rodrigo, CIO da Nitro, e funciona como o lugar central para desabafar, reorganizar a cabeça e pensar estratégia, em temas de trabalho e de vida pessoal.

O diferencial não é a voz, é a combinação de **franqueza máxima (5/5)** com **memória de longo prazo**: Nina lembra do que foi dito, cobra o que foi combinado e não puxa o saco.

## 2. Contexto e problema

- Um CIO decide muito, sob pressão, e tem pouca gente disposta a dizer verdades duras sem filtro político.
- Os pensamentos se espalham em reuniões, WhatsApp, cabeça e anotações soltas. Falta um lugar único que **acumule contexto** e devolva clareza.
- Ferramentas de IA genéricas esquecem tudo a cada conversa e tendem a concordar com o usuário.

## 3. Usuário e jobs to be done

**Usuário:** Rodrigo Silva, CIO da Nitro. Uso pessoal, sem convidados.

| Job | Situação típica | O que Nina entrega |
| :---- | :---- | :---- |
| Desabafar | Fim de dia pesado, conflito, frustração | Escuta, nomeia o que está acontecendo, devolve perspectiva sem passar a mão na cabeça |
| Reorganizar a cabeça | Muitas frentes abertas, sensação de caos | Separa o que importa, aponta o que está sendo evitado, define o próximo passo |
| Estratégia | Decisão de time, orçamento, fornecedor, board, carreira, IA | Conselho direto, trade-offs, riscos, posição clara |

## 4. Objetivos e não objetivos

**Objetivos**
- Conversa por voz fluida em PT-BR, com entrada por áudio ou texto.
- Persona Nina consistente: dura, franca, direta, que apoia de verdade.
- Memória que não se perde: histórico completo, fatos sobre o Rodrigo, temas abertos e compromissos.
- Nina pergunta quando houver dúvida em vez de supor.

**Não objetivos (MVP)**
- Múltiplos usuários, convidados, monetização.
- Chamada de voz em tempo real (é troca de mensagens de voz).
- Acesso a e-mail, agenda, Jira ou sistemas da Nitro.
- Interface web ou dashboard.
- Mensagens proativas da Nina (fica para a fase 2).

## 5. Métricas de sucesso

| Métrica | Meta (30 dias) | Tipo |
| :---- | :---- | :---- |
| Dias com conversa por semana | ≥ 3 | Adoção (leading) |
| Respostas avaliadas como úteis (👍) | ≥ 70% | Qualidade |
| Vezes que Nina retoma contexto antigo corretamente | Percepção qualitativa semanal | Memória |
| Tempo do envio do áudio até a resposta em voz | ≤ 25s para respostas de até 1 min | Experiência |
| Falhas sem resposta | 0 silenciosas (toda falha gera mensagem) | Confiabilidade |

## 6. Requisitos funcionais

**RF1. Entrada**
- Aceitar mensagem de voz (voice note), áudio e texto.
- Transcrever áudio para texto em PT-BR.
- Ignorar silenciosamente qualquer usuário que não seja o Telegram ID do Rodrigo.

**RF2. Resposta**
- Gerar resposta com a persona Nina (ver `prompts/nina-system-prompt.md`).
- Devolver **áudio + texto** da resposta.
- Duração alvo de até 2 minutos, sem limite rígido. Respostas longas são divididas em mais de uma mensagem de voz, na ordem.
- Indicar "gravando áudio..." no Telegram enquanto processa.

**RF3. Memória**
- Guardar todo o histórico (texto das mensagens e respostas).
- Após cada troca, extrair e atualizar memórias estruturadas: fatos, pessoas, decisões, compromissos e temas abertos.
- Em cada resposta, Nina recebe: perfil do Rodrigo, temas abertos, compromissos pendentes, memórias relevantes à mensagem atual (busca semântica) e as mensagens recentes.

**RF4. Tom**
- Padrão: 5/5, sem bajulação.
- Muda somente se o Rodrigo pedir, e a mudança fica registrada até ele pedir para voltar.

**RF5. Comandos** (atalhos digitados no Telegram, começando com `/`)
| Comando | Função |
| :---- | :---- |
| `/start` | Apresentação da Nina |
| `/memoria` | Nina resume o que sabe sobre você e o que está em aberto |
| `/esquecer` | Apaga uma memória específica ou tudo (pede confirmação) |
| `/tom` | Mostra ou altera o tom atual |
| `/texto` e `/voz` | Liga ou desliga o áudio na resposta |

**RF6. Feedback**
- Cada resposta traz botões 👍 / 👎 para medir utilidade.

## 7. Requisitos não funcionais

- **Segurança:** webhook do Telegram com `secret_token`; whitelist de um único user ID; tabelas com RLS ativo e acesso só por service role; chaves somente em Supabase Secrets.
- **Privacidade (LGPD):** conteúdo pessoal e sensível de um único titular, uso interno. Áudios não são armazenados (só a transcrição). `/esquecer` apaga de fato.
- **Confiabilidade:** responder 200 ao Telegram imediatamente e processar em segundo plano; deduplicar por `update_id`; toda falha gera aviso ao usuário e log.
- **Observabilidade:** log por troca com latência de cada etapa (STT, LLM, TTS), tokens e custo estimado.
- **Portabilidade:** STT, LLM e TTS atrás de interfaces simples para trocar fornecedor por configuração.

## 8. Arquitetura e stack

```
Telegram (áudio ou texto)
  → Supabase Edge Function "telegram-webhook" (Deno/TypeScript)
      1. valida secret + user ID, deduplica update_id, responde 200
      2. em segundo plano:
         a. baixa o áudio do Telegram → OpenAI gpt-4o-transcribe (STT)
         b. monta contexto: perfil + temas abertos + compromissos
            + memórias relevantes (pgvector) + mensagens recentes
         c. Claude (claude-opus-5-5) gera a resposta da Nina
         d. TTS: ElevenLabs (voz escolhida) → OGG/Opus
            fallback: OpenAI gpt-4o-mini-tts
         e. envia voice note + texto + botões de feedback
         f. Claude Haiku 5.5 extrai memórias da troca e grava
  → Supabase Postgres + pgvector (histórico, memórias, logs)
```

| Camada | Escolha | Por quê |
| :---- | :---- | :---- |
| Hospedagem | Supabase Edge Functions | Você já usa Supabase e as chaves já estão lá |
| Banco e memória | Postgres + pgvector | Histórico, memórias estruturadas e busca semântica no mesmo lugar |
| Cérebro | Claude Opus 5.5, esforço baixo ou médio | Melhor sustentação de persona franca e julgamento; esforço controla latência |
| Extração de memória | Claude Haiku 5.5 | Barato e rápido, roda depois da resposta |
| STT | OpenAI gpt-4o-transcribe | Boa precisão em PT-BR |
| Embeddings | OpenAI text-embedding-3-small | Busca semântica nas memórias |
| TTS | ElevenLabs (sua voz), OpenAI como fallback | Identidade sonora da Nina e melhor naturalidade em PT-BR |

### Modelo de dados (resumo)

| Tabela | Conteúdo |
| :---- | :---- |
| `messages` | Cada mensagem do Rodrigo e da Nina: texto, origem (voz ou texto), duração, tokens, latências |
| `memories` | Memórias atômicas: tipo (fato, pessoa, decisão, compromisso, tema aberto, padrão), conteúdo, status, data, embedding |
| `profile` | Perfil estável do Rodrigo e preferências (inclui o tom atual) |
| `processed_updates` | `update_id` já tratados, para não responder duas vezes |
| `feedback` | 👍 / 👎 por resposta |

## 9. Critérios de aceite

1. **Dado** que Rodrigo envia um áudio, **quando** a Nina processa, **então** ele recebe uma mensagem de voz e o texto correspondente.
2. **Dado** que outra pessoa escreve para o bot, **quando** a mensagem chega, **então** nada é respondido nem armazenado.
3. **Dado** que Rodrigo mencionou um compromisso numa conversa anterior, **quando** volta a falar do tema dias depois, **então** Nina retoma o compromisso sem ser lembrada.
4. **Dado** que a mensagem é ambígua, **quando** a Nina responde, **então** ela faz uma pergunta objetiva antes de aconselhar.
5. **Dado** que Rodrigo pede "pega mais leve", **quando** a Nina responde, **então** o tom muda e permanece assim até ele pedir para voltar.
6. **Dado** que o TTS principal falha, **quando** a resposta está pronta, **então** o áudio sai pelo fallback ou, no pior caso, só em texto com aviso.
7. **Dado** que o Telegram reenvia o mesmo update, **quando** ele chega, **então** não há resposta duplicada.
8. **Dado** que Rodrigo usa `/esquecer` e confirma, **quando** a operação termina, **então** a memória deixa de aparecer em `/memoria` e nas respostas.
9. **Dado** um sinal de risco à integridade do Rodrigo, **quando** a Nina responde, **então** ela abandona a dureza, acolhe e indica ajuda imediata (CVV 188).

## 10. Dependências e riscos

| Risco | Impacto | Mitigação |
| :---- | :---- | :---- |
| Limite de tempo da Edge Function em respostas longas | Resposta cortada | Processar em segundo plano, esforço controlado, dividir TTS em partes; se necessário, fila em tabela + segunda função |
| Memória crescer e poluir o contexto | Respostas confusas | Memórias atômicas com status (aberto, resolvido), busca semântica top K, resumo periódico |
| Dureza 5/5 em momento de fragilidade pessoal | Dano real | Guardrail explícito no prompt para crise; Nina muda de postura nesses casos |
| Transcrição errada de nomes e siglas | Conselho fora de contexto | Glossário de nomes no perfil, enviado como dica ao STT |
| Concentração de dados sensíveis | Exposição | RLS, sem áudio armazenado, chaves em Secrets, `/esquecer` |
| Custo sem limite | Surpresa na fatura | Log de custo por troca e resumo semanal |

**Dependências:** bot criado no BotFather (token), Telegram user ID do Rodrigo, chaves Anthropic, OpenAI e ElevenLabs em Supabase Secrets, `voice_id` da ElevenLabs.

## 11. Plano de rollout

1. **Semana 1:** fluxo ponta a ponta (texto e voz) sem memória longa. Teste diário.
2. **Semana 2:** memória estruturada, `/memoria`, `/esquecer`, feedback.
3. **Semana 3 e 4:** ajuste fino do prompt com base em 👎 e conversas reais.
4. **Fase 2 (após 30 dias):** Nina proativa (check-in diário, cobrança de compromissos com prazo), resumo semanal por voz.

## 12. Backlog inicial

| # | Épico | História | Prioridade |
| :-- | :---- | :---- | :---- |
| 1 | Fundação | Projeto Supabase, tabelas, RLS, secrets, bot no BotFather, webhook | P0 |
| 2 | Conversa | Texto → Claude → texto | P0 |
| 3 | Voz | STT na entrada, TTS na saída com fallback, divisão de respostas longas | P0 |
| 4 | Memória | Histórico, extração com Haiku, embeddings, montagem de contexto | P0 |
| 5 | Controle | Comandos `/memoria`, `/esquecer`, `/tom`, `/texto`, `/voz` | P1 |
| 6 | Qualidade | Botões de feedback, logs de latência e custo | P1 |
| 7 | Proatividade | Check-in diário e cobrança de compromissos (pg_cron) | P2 |
