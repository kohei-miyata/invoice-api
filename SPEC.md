# Invoice Manager — 仕様書

## 概要

請求書・領収書をアップロードすると Claude AI が自動でデータ抽出・会社照合を行うマルチテナント SaaS。

| 項目 | 内容 |
|------|------|
| バックエンド | Python 3.12 / FastAPI (非同期) |
| データベース | PostgreSQL 16 (ローカル: Docker / 本番: AWS RDS) |
| ファイルストレージ | AWS S3 |
| AI エンジン | Anthropic Claude (`claude-haiku-4-5-20251001`) |
| フロントエンド | バニラ HTML / CSS / JavaScript |
| ローカル実行環境 | Docker Compose |
| 本番実行環境 | AWS ECS Fargate |

---

## アーキテクチャ

### ローカル開発

```
ブラウザ
  └── /static  (HTML / CSS / JS)
       └── API リクエスト (X-Tenant-Slug ヘッダー付き)
            └── FastAPI (localhost:8000)
                 ├── TenantMiddleware  ← テナント識別
                 ├── /api/invoices    ← 請求書管理
                 ├── /api/masters     ← 会社マスタ
                 └── /api/approvals   ← 承認管理
                      ├── PostgreSQL (Docker コンテナ)
                      ├── AWS S3 (ファイルストレージ)
                      └── Anthropic API (AI 解析)
```

### 本番環境 (AWS)

```
ブラウザ
  └── ALB (invoice-alb-1136964932.ap-northeast-1.elb.amazonaws.com)
       └── ECS Fargate (invoice-cluster / invoice-api-service)
            └── FastAPI コンテナ (ECR: invoice-api)
                 ├── TenantMiddleware
                 ├── /api/invoices
                 ├── /api/masters
                 └── /api/approvals
                      ├── RDS PostgreSQL 16 (invoice.chy0yue8o2e0.ap-northeast-1.rds.amazonaws.com)
                      ├── S3 (invoice-storage-mk)
                      └── Anthropic API
```

---

## マルチテナント設計

`public.tenants` テーブルでテナントを管理し、テナントごとに独立した PostgreSQL スキーマ (`tenant_{slug}`) を持つ。

| テーブル | スキーマ |
|----------|----------|
| tenants | public |
| companies | tenant_{slug} |
| invoices | tenant_{slug} |
| approvals | tenant_{slug} |

### テナント識別

リクエストごとに以下の優先順位でテナントを特定する。

1. `X-Tenant-Slug` リクエストヘッダー（ローカル開発・API 直接呼び出し）
2. サブドメイン（例: `acme.example.com` → slug = `acme`、AWS ドメインは除外）
3. フォールバック: `default` テナント（ALB/AWS ドメインからのアクセス時）

スラグは小文字英数字・ハイフン・アンダースコアのみ許可。

### ローカル開発用デフォルトテナント

| スラグ | 説明 |
|--------|------|
| `demo` | サンプル会社データ入り |
| `default` | 空のテナント |

### テナント新規作成

```
POST /api/tenants/provision?slug={slug}&name={name}
```

PostgreSQL の `public.provision_tenant()` 関数を呼び出し、スキーマとテーブルを自動作成する。

---

## データベーススキーマ

### `companies` (会社マスタ)

| カラム | 型 | 説明 |
|--------|----|------|
| id | UUID | 主キー |
| name | VARCHAR(255) | 会社名（必須） |
| registration_number | VARCHAR(50) | 適格請求書登録番号 |
| address | TEXT | 住所 |
| phone | VARCHAR(50) | 電話番号 |
| email | VARCHAR(255) | メールアドレス |
| notes | TEXT | 備考 |
| created_at | TIMESTAMP | 作成日時 |
| updated_at | TIMESTAMP | 更新日時 |

### `invoices` (請求書)

| カラム | 型 | 説明 |
|--------|----|------|
| id | UUID | 主キー |
| s3_key | VARCHAR(500) | S3 オブジェクトキー |
| original_filename | VARCHAR(255) | 元ファイル名 |
| file_type | VARCHAR(20) | ファイル種別 (pdf / jpg / png 等) |
| status | VARCHAR(50) | ステータス（後述） |
| extracted_data | JSONB | AI 抽出データ |
| company_id | UUID | 照合された会社 (companies.id) |
| matching_score | FLOAT | 照合スコア (0.0〜1.0) |
| ai_input_tokens | INTEGER | AI 解析で使用した入力トークン数 |
| ai_output_tokens | INTEGER | AI 解析で使用した出力トークン数 |
| created_at | TIMESTAMP | 作成日時 |
| updated_at | TIMESTAMP | 更新日時 |

**ステータス一覧**

| 値 | 説明 |
|----|------|
| `processed` | AI 解析済 |
| `approved` | 承認済 |

### `approvals` (承認)

| カラム | 型 | 説明 |
|--------|----|------|
| id | UUID | 主キー |
| invoice_id | UUID | 請求書 ID (invoices.id) |
| approver_id | VARCHAR(255) | 承認者 ID (メールアドレス等) |
| approver_name | VARCHAR(255) | 承認者名 |
| status | VARCHAR(50) | pending / approved / rejected |
| comment | TEXT | コメント |
| created_at | TIMESTAMP | 作成日時 |
| updated_at | TIMESTAMP | 更新日時 |

---

## API エンドポイント

全エンドポイントに `X-Tenant-Slug` ヘッダーが必要（`/health`, `/`, `/static/**` を除く）。

### ヘルスチェック

| メソッド | パス | 説明 |
|----------|------|------|
| GET | `/health` | サービス死活確認 |

### 請求書 `/api/invoices`

| メソッド | パス | 説明 |
|----------|------|------|
| GET | `/api/invoices` | 一覧取得 |
| POST | `/api/invoices` | アップロード + AI 解析 |
| GET | `/api/invoices/{id}` | 単件取得 |
| PUT | `/api/invoices/{id}` | 更新 |
| DELETE | `/api/invoices/{id}` | 削除 |
| POST | `/api/invoices/{id}/process` | 再解析 |
| GET | `/api/invoices/{id}/download-url` | S3 署名付き URL 取得 |
| GET | `/api/invoices/usage-stats` | AI 使用量統計取得 |

**GET `/api/invoices` クエリパラメータ**

| パラメータ | 型 | デフォルト | 説明 |
|------------|----|-----------|------|
| status | string | — | ステータスでフィルタ |
| limit | int | 50 | 最大取得件数 (1〜200) |
| offset | int | 0 | 取得開始位置 |

**POST `/api/invoices` (アップロード)**

- `multipart/form-data` で `file` フィールドにファイルを添付
- 対応形式: `pdf`, `jpg`, `jpeg`, `png`, `gif`, `webp`
- 処理フロー:
  1. S3 にアップロード（`tenants/{slug}/{company_id}/{doc_type}/{timestamp}.{ext}`）
  2. Claude AI でデータ抽出（文書種別・請求書番号・金額等）
  3. 会社マスタと照合（スコア 0.5 以上で自動紐付け）
  4. DB に保存（status: `processed`、AI トークン使用量も記録）
  5. 抽出データ + 照合候補を返却

**GET `/api/invoices/usage-stats`**

テナントの AI 使用量集計を返す。

```json
{
  "total": 42,
  "ai_processed": 38,
  "input_tokens": 120000,
  "output_tokens": 15000,
  "estimated_cost_usd": 0.048,
  "estimated_cost_jpy": 7
}
```

**POST `/api/invoices/{id}/process` (再解析)**

- S3 からファイルを取得して再度 AI 解析を実行
- 抽出データ・照合結果を上書き保存

### 会社マスタ `/api/masters`

| メソッド | パス | 説明 |
|----------|------|------|
| GET | `/api/masters` | 一覧取得（名前順） |
| POST | `/api/masters` | 新規登録 |
| GET | `/api/masters/{id}` | 単件取得 |
| PUT | `/api/masters/{id}` | 更新 |
| DELETE | `/api/masters/{id}` | 削除 |
| POST | `/api/masters/import-csv` | CSV 一括インポート |

### 承認 `/api/approvals`

| メソッド | パス | 説明 |
|----------|------|------|
| GET | `/api/approvals` | 一覧取得 |
| POST | `/api/approvals` | 承認依頼作成 |
| GET | `/api/approvals/{id}` | 単件取得 |
| PUT | `/api/approvals/{id}` | 承認 / 却下 |
| DELETE | `/api/approvals/{id}` | 削除 |

**GET `/api/approvals` クエリパラメータ**

| パラメータ | 型 | 説明 |
|------------|----|------|
| invoice_id | UUID | 請求書 ID でフィルタ |
| status | string | ステータスでフィルタ |

**PUT `/api/approvals/{id}` リクエストボディ**

```json
{
  "status": "approved",  // "approved" or "rejected"
  "comment": "確認済み"
}
```

---

## AI 機能

### データ抽出 (`extract_invoice_data`)

Claude にファイルを base64 エンコードして送信し、以下フィールドを JSON で抽出する。

| フィールド | 説明 |
|-----------|------|
| document_type | 文書種別（請求書 / 領収書） |
| invoice_number | 請求書番号 |
| invoice_date | 発行日 (YYYY-MM-DD) |
| due_date | 支払期限 (YYYY-MM-DD) |
| vendor_name | 発行者・会社名 |
| vendor_address | 発行者住所 |
| vendor_registration_number | 適格請求書登録番号 |
| buyer_name | 宛先 |
| subtotal | 小計 |
| tax_amount | 消費税額 |
| total_amount | 合計金額 |
| currency | 通貨コード (JPY 等) |
| line_items | 明細行の配列 |
| notes | 備考 |

- PDF は `document` タイプ、画像は `image` タイプで送信
- システムプロンプトに `cache_control: ephemeral` を設定しプロンプトキャッシュを活用

### 会社照合 (`match_company`)

抽出した発行者情報と会社マスタを Claude で照合し、上位 3 件の候補をスコア付きで返す。

| フィールド | 説明 |
|-----------|------|
| company_id | 会社マスタの UUID |
| company_name | 会社名 |
| score | 一致スコア (0.0〜1.0) |
| reason | 一致理由 |

スコアが 0.5 以上の最上位候補を自動で請求書に紐付ける。

---

## ファイルストレージ (AWS S3)

| 項目 | 内容 |
|------|------|
| S3 バケット | `invoice-storage-mk` (ap-northeast-1) |
| S3 キー形式 | `tenants/{slug}/{company_id}/{doc_type}/{timestamp}.{ext}` |
| doc_type 分類 | `invoice`（請求書）/ `receipt`（領収書）/ `unknown` |
| 未紐付けファイル | `tenants/{slug}/unassigned/{doc_type}/{timestamp}.{ext}` |
| 会社紐付け変更時 | 自動でファイルを新しいパスに移動 |
| 署名付き URL 有効期限 | 3600 秒（1時間） |

---

## フロントエンド

`/static` 以下に配置されるシングルページアプリケーション。

### 画面構成

```
サイドバー
  ├── 請求書管理 (invoices)
  ├── 会社マスタ (masters)
  └── 承認管理 (approvals)
```

### 請求書管理画面

- **アップロードゾーン**: ドラッグ&ドロップ / ファイル選択 / フォルダ選択（複数ファイル一括）
  - 重複ファイル検出: 同名ファイルがあると上書き確認モーダルを表示
  - **プログレスパネル**: アップロード中にプログレスバーとログを表示
    - 処理中ファイル名・完了数 / 総数・エラー行を逐次更新
    - 複数ファイルは 1 件ずつ順次処理（解析結果モーダルを都度表示）
- **一覧テーブル**: ファイル名 / 文書種別 / ステータス / 発行者 / 請求書番号 / 合計金額 / 紐付け会社 / 登録日 / 操作
  - ステータスフィルタ・テキスト検索対応
  - ページネーション（1 ページ 20 件）
  - **CSV エクスポート**: 現在の絞り込み結果を CSV でダウンロード
  - ストレージリンクボタン: S3 署名付き URL を取得して新タブで開く
- **詳細モーダル**: 抽出データ全項目・明細行・照合スコアを表示
  - 「再解析」ボタンで再度 AI 解析を実行
- **編集モーダル**: ステータス・文書種別・紐付け会社を手動変更
  - 会社変更時に S3 ファイルを自動移動
- **AI 使用量表示**: ヘッダーにテナントの累計 AI トークン数・推定コストを表示

### 会社マスタ画面

- 会社一覧（名前・登録番号・住所・電話・メール）
- テキスト検索対応
- 新規登録 / 編集 / 削除
- **CSV インポート**: CSV ファイルから会社データを一括登録
  - サンプル CSV ダウンロードボタンあり

### 承認管理画面

- 承認レコード一覧（請求書ID / 承認者 / ステータス / コメント）
- ステータスフィルタ対応
- 承認依頼作成 / 承認 / 却下 / 削除

### URL ルーティング

History API を使用したパスベースルーティング。各ページに固有 URL が付与され、ブラウザの戻る/進むが機能する。

| パス | 画面 |
|------|------|
| `/invoices` | 請求書管理 |
| `/masters` | 会社マスタ |
| `/approvals` | 承認管理 |

### テナント切り替え

サイドバー下部のセレクトボックスでテナントをリアルタイム切り替え。

---

## 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
|--------|------|-----------|------|
| `DATABASE_URL` | ○ | — | PostgreSQL 接続 URL (`postgresql+asyncpg://...`) |
| `ANTHROPIC_API_KEY` | ○ | — | Anthropic API キー |
| `AWS_ACCESS_KEY_ID` | ○ | — | AWS アクセスキー ID |
| `AWS_SECRET_ACCESS_KEY` | ○ | — | AWS シークレットアクセスキー |
| `AWS_REGION` | — | `ap-northeast-1` | AWS リージョン |
| `S3_BUCKET_NAME` | — | `invoice-bucket` | S3 バケット名 |
| `CORS_ORIGINS` | — | `["*"]` | CORS 許可オリジン (JSON 配列) |
| `CLAUDE_MODEL` | — | `claude-haiku-4-5-20251001` | 使用する Claude モデル ID |

---

## ローカル開発環境

### 前提条件

- Docker Desktop がインストール・起動済みであること
- Anthropic API キー（[console.anthropic.com](https://console.anthropic.com) で取得）
- AWS アカウントおよび S3 バケット

### セットアップ

```bash
# 1. リポジトリをクローン
git clone <repository-url>
cd invoice-api

# 2. 環境変数を設定
cp .env.example .env   # .env を編集して各キーを入力

# 3. 起動
docker compose up --build
```

起動後:
- アプリ: http://localhost:8000
- API ドキュメント (Swagger): http://localhost:8000/docs

### DB のみ起動

```bash
docker compose up db -d
```

接続情報: `localhost:5432` / ユーザー: `postgres` / パスワード: `postgres` / DB: `invoices`

### コンテナ停止

```bash
docker compose down        # コンテナのみ停止
docker compose down -v     # DB データも削除
```

---

## 本番環境 (AWS) セットアップ

### AWS リソース構成

| リソース | 名前 / 識別子 | 説明 |
|----------|---------------|------|
| リージョン | `ap-northeast-1` | 東京 |
| ECR リポジトリ | `invoice-api` | Docker イメージ保管 |
| ECS クラスター | `invoice-cluster` | コンテナ実行基盤 |
| ECS サービス | `invoice-api-service-m0vsy377` | Fargate タスク管理 |
| ECS タスク定義 | `invoice-api` | コンテナ設定（CPU 256, メモリ 512MB） |
| ALB | `invoice-alb` | ロードバランサー（ポート 80） |
| RDS | `invoice` | PostgreSQL 16（`invoices` DB） |
| S3 バケット | `invoice-storage-mk` | ファイルストレージ |

**公開エンドポイント**

```
http://invoice-alb-1136964932.ap-northeast-1.elb.amazonaws.com
```

### 初回セットアップ手順

**前提**: AWS CLI インストール・認証済み、Docker インストール済み。

#### 1. ECR へ初回イメージプッシュ

```bash
# ECR ログイン
aws ecr get-login-password --region ap-northeast-1 | \
  docker login --username AWS --password-stdin \
  717728192619.dkr.ecr.ap-northeast-1.amazonaws.com

# Apple Silicon Mac の場合は linux/amd64 でビルド
docker buildx build --platform linux/amd64 \
  -t 717728192619.dkr.ecr.ap-northeast-1.amazonaws.com/invoice-api:latest \
  --push .
```

#### 2. RDS データベース初期化

RDS に一時的にパブリックアクセスを許可してから psql で初期化する。

```bash
# パブリックアクセス有効化（作業後に無効化すること）
aws rds modify-db-instance \
  --db-instance-identifier invoice \
  --publicly-accessible \
  --apply-immediately \
  --region ap-northeast-1

# RDS SG にローカル IP を追加
MY_IP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress \
  --group-id sg-0812bf2e25e095576 \
  --protocol tcp --port 5432 \
  --cidr ${MY_IP}/32 \
  --region ap-northeast-1

# init.sql 実行
PGPASSWORD='<RDSパスワード>' psql \
  "host=invoice.chy0yue8o2e0.ap-northeast-1.rds.amazonaws.com \
   port=5432 dbname=invoices user=postgres" \
  -f migrations/init.sql

# クリーンアップ（パブリックアクセス無効化・IP 削除）
aws ec2 revoke-security-group-ingress \
  --group-id sg-0812bf2e25e095576 \
  --protocol tcp --port 5432 \
  --cidr ${MY_IP}/32 \
  --region ap-northeast-1

aws rds modify-db-instance \
  --db-instance-identifier invoice \
  --no-publicly-accessible \
  --apply-immediately \
  --region ap-northeast-1
```

#### 3. ECS タスク定義の環境変数

ECS タスク定義に以下の環境変数を設定する。

| 変数名 | 値 |
|--------|-----|
| `DATABASE_URL` | `postgresql+asyncpg://postgres:<pass>@invoice.chy0yue8o2e0.ap-northeast-1.rds.amazonaws.com:5432/invoices` |
| `ANTHROPIC_API_KEY` | Anthropic コンソールで取得したキー |
| `AWS_ACCESS_KEY_ID` | IAM ユーザーのアクセスキー |
| `AWS_SECRET_ACCESS_KEY` | IAM ユーザーのシークレットキー |
| `AWS_REGION` | `ap-northeast-1` |
| `S3_BUCKET_NAME` | `invoice-storage-mk` |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` |

---

## CI/CD (GitHub Actions)

`main` ブランチへのプッシュで自動デプロイが実行される。

### ワークフロー概要 (`.github/workflows/deploy.yml`)

```
git push origin main
  └── GitHub Actions
       1. linux/amd64 で Docker イメージをビルド
       2. ECR へプッシュ（:sha + :latest タグ）
       3. ECS サービスを force-new-deployment
       4. aws ecs wait services-stable で完了を待機
```

### 所要時間

| ステップ | 目安 |
|----------|------|
| イメージビルド & ECR プッシュ | 約 2〜3 分 |
| ECS ローリングデプロイ | 約 1〜2 分 |
| 合計 | 約 3〜5 分 |

### 必要な GitHub Secrets

| Secret 名 | 説明 |
|-----------|------|
| `AWS_ACCESS_KEY_ID` | ECS / ECR 操作権限を持つ IAM ユーザーのキー |
| `AWS_SECRET_ACCESS_KEY` | 同上のシークレットキー |

### API へのリクエスト例

```bash
# テナント指定が必要
curl -H "X-Tenant-Slug: demo" http://localhost:8000/api/invoices

# ファイルアップロード
curl -X POST \
  -H "X-Tenant-Slug: demo" \
  -F "file=@invoice.pdf" \
  http://localhost:8000/api/invoices
```

---

## ディレクトリ構成

```
invoice-api/
├── .github/
│   └── workflows/
│       └── deploy.yml       # CI/CD: main push → ECR → ECS 自動デプロイ
├── app/
│   ├── main.py              # FastAPI アプリ定義・ルーター登録
│   ├── config.py            # 環境変数設定 (pydantic-settings)
│   ├── db.py                # DB セッション管理（テナントスキーマ切り替え）
│   ├── schemas.py           # Pydantic スキーマ
│   ├── middleware/
│   │   └── tenant.py        # テナント識別ミドルウェア
│   ├── routers/
│   │   ├── invoices.py      # 請求書 API
│   │   ├── masters.py       # 会社マスタ API (CSV インポート含む)
│   │   └── approvals.py     # 承認 API
│   ├── services/
│   │   ├── claude.py        # Claude AI 連携（抽出・照合・トークン計測）
│   │   └── s3.py            # AWS S3 連携（アップロード・移動・署名付き URL）
│   └── static/
│       ├── index.html       # SPA エントリポイント
│       ├── css/style.css    # スタイルシート
│       └── js/
│           ├── api.js       # API クライアント
│           ├── app.js       # アプリ起動・URL ルーティング・共通処理
│           ├── invoices.js  # 請求書画面ロジック（プログレス・CSV エクスポート）
│           ├── masters.js   # 会社マスタ画面ロジック（CSV インポート）
│           └── approvals.js # 承認管理画面ロジック
├── migrations/
│   └── init.sql             # DB 初期化 SQL (テナントプロビジョニング関数含む)
├── terraform/               # インフラ定義 (AWS)
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── .env                     # 環境変数（Git 管理外）
```
