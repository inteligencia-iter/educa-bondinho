# Educa Bondinho — Monitor Comercial

Monitor de prospecção de escolas particulares do Rio de Janeiro para venda de visitações educacionais ao Parque Bondinho. Inspirado no [Monitor de Eventos - Visit Rio](https://inteligencia-iter.github.io/monitor-comercial/).

## Como abrir localmente

Basta abrir o arquivo `index.html` diretamente no navegador (duplo clique). Todos os dados já estão embutidos em `data/escolas.js`, então não é necessário rodar um servidor.

## Como publicar no GitHub Pages

1. Suba esta pasta inteira (`index.html`, `css/`, `js/`, `data/`) para a raiz de um repositório.
2. Nas configurações do repositório, ative o GitHub Pages apontando para a branch principal, pasta raiz (`/`).
3. Pronto — o link gerado já abre o monitor.

## Dados

Fonte: planilha do Censo Escolar (INEP) com as 11.761 escolas do Estado do Rio de Janeiro, filtradas para as **4.903 escolas de Categoria Administrativa "Privada"**.

### Tratamento de Latitude/Longitude

A planilha trazia as coordenadas sem separador decimal (ex: `-2113028` em vez de `-21.13028`), além de ~23% dos registros sem coordenada alguma. O pipeline (`(scripts removidos após a validação, lógica documentada aqui)`) fez o seguinte:

1. **Reconstrução do decimal**: os 2 primeiros dígitos formam a parte inteira (latitudes do RJ vão de -20 a -23°; longitudes de -40 a -44°), o restante vira a parte decimal.
2. **Validação redundante**: 
   - Comparação do município extraído por regex do campo *Endereço* com a coluna *Município* → **100% de correspondência** (11.761/11.761).
   - Reverse geocoding de uma amostra aleatória de 25 escolas via Nominatim/OpenStreetMap → **100% de acerto** do município.
   - Nenhuma coordenada caiu fora da bounding box do Estado do RJ.
3. **Preenchimento das coordenadas ausentes** (hierarquia de fallback, sempre registrada no campo `geo_source` de cada escola):
   - `exato`: coordenada original da planilha, validada (2.952 escolas).
   - `geocodificado`: endereço geocodificado via Nominatim/OpenStreetMap (60 escolas — amostra inicial; pode ser expandido).
   - `aproximado_bairro`: centróide das escolas do mesmo bairro+município com coordenada válida (1.044 escolas).
   - `aproximado_zona`: centróide das escolas da mesma Zona (no município do Rio) ou Região do Estado (fora do Rio) (847 escolas).

   Cobertura final: **100% das escolas privadas plotáveis no mapa**, com transparência sobre o nível de precisão (visível no popup do mapa quando a localização é aproximada).

### Regiões e zonas

As colunas *Região do Estado* (8 regiões de governo do RJ) e *Divisão Geográfica e Administrativa* (Zona Sul, Zona Norte, Zona Oeste, Zona Sudoeste, Centro — para o município do Rio) já vinham calculadas na planilha original e foram conferidas contra a divisão oficial (CEPERJ/Prefeitura do Rio): a "Região Metropolitana" da planilha bate exatamente com a lista oficial de 19 municípios.

## Persistência dos dados de prospecção (checks e follow-up) — Firebase

O monitor já vem integrado com **Firebase Firestore** para sincronizar em tempo real o progresso de todo o time (contactada, etapa de follow-up, notas, histórico) entre qualquer navegador/dispositivo. Enquanto o Firebase não estiver configurado, ele funciona em **modo local** (localStorage, sem sincronizar entre pessoas) — dá pra usar assim também, sem quebrar nada.

### Como ativar (uma vez só)

1. Acesse [console.firebase.google.com](https://console.firebase.google.com) e crie um projeto novo (gratuito).
2. Dentro do projeto, clique no ícone `</>` ("Adicionar app da Web"), dê um nome (ex: "educa-bondinho") e **não** marque a opção de Firebase Hosting. Ele vai mostrar um objeto `firebaseConfig` — copie os valores.
3. Cole esses valores em `js/firebase-config.js`, substituindo os campos que começam com `SUA_`.
4. No menu lateral, vá em **Build > Firestore Database** → "Criar banco de dados" → modo de produção → escolha a região `southamerica-east1` (São Paulo, mais perto do RJ).
5. Ainda no Firestore, vá na aba **Regras** e cole:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /leads_state/{docId} {
         allow read: if true;
         allow write: if request.auth != null;
       }
     }
   }
   ```

   Isso permite que qualquer um com o link veja os dados (sem problema, são só status de contato), mas só quem passou pela autenticação do app pode gravar.

6. No menu lateral, vá em **Build > Authentication** → "Vamos começar" → na aba "Sign-in method", ative o provedor **Anônimo**. É o que permite o app gravar dados sem exigir login/senha de verdade do time.
7. Salve `js/firebase-config.js`, publique o site (ou só recarregue localmente) — o indicador no topo do header muda de "● modo local" para "● sincronizado".

### Identificação de quem faz cada ação

Em vez de deixar a pessoa digitar o nome livremente (o que gera duplicidade tipo "Ana" / "ana" / "Ana Souza" no histórico), o monitor usa uma **lista fixa** definida em `js/team-config.js`:

```js
const TEAM_MEMBERS = ["Ana", "Bruno", "Carla"];
```

Ao abrir o monitor pela primeira vez naquele navegador, a pessoa escolhe o nome dela num menu suspenso (fica salvo só ali). Se o nome não estiver na lista ainda, tem uma opção "Meu nome não está na lista..." que libera um campo de texto como alternativa. Quando alguém novo entrar no time, é só adicionar o nome em `js/team-config.js`.

Esse nome aparece em todo o histórico de follow-up, tipo "Contactada por Ana — 26/07 14:32", pra saber quem cuidou de cada lead.

### Se preferir não usar Firebase

Não precisa fazer nada — o monitor detecta que `js/firebase-config.js` ainda está com os valores de exemplo e roda 100% em localStorage, exatamente como antes.

## Abas do monitor

- **Mapa**: escolas privadas plotadas com Leaflet + clusterização, sobre um basemap claro (CartoDB Positron). Filtro de nível geográfico (Município do Rio → Região Metropolitana → Estado do RJ) com subfiltro dinâmico (Zona / Município / Região do Estado, conforme o nível), filtro de modalidade de ensino, legenda recolhível, popup com nome/modalidade/telefone e check de "contactada" (esmaece o pino).
- **Leads**: tabela filtrável (busca por nome, região, zona, modalidade, contactadas). Clique na linha abre um painel lateral com todos os detalhes da escola.
- **Follow Up**: quadro kanban com 4 etapas (Novo Lead/1º Contato → Em Negociação → Visita Agendada → Visita Realizada). Escolas entram automaticamente ao serem marcadas como contactadas. Arraste o card entre colunas ou use o menu de seleção — que também tem a opção "Sem follow-up iniciado", pra desfazer um registro feito sem querer (a escola volta a aparecer como "Sem contato"). Cada card tem um botão "🕒 Histórico" que expande a lista de mudanças de etapa com data/hora e nome de quem fez, sem precisar abrir o painel lateral.
- **Rejeitados / Sem Resposta**: escolas que saíram do funil por rejeição ou falta de retorno, com motivo e data. Botão "Reativar" devolve a escola ao início do funil.

## Cores e tipografia

Fonte Poppins (Google Fonts) e cor principal `#ff6600`, conforme identidade do projeto.
