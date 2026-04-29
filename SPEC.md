# Invoice Manager — 仕様書

## 概要

請求書・領収書をアップロードすると Claude AI が自動でデータ抽出・会社照合を行うマルチテナント SaaS。

| 項目 | 内容 |
|------|------|
| バックエンド | Python 3.12 / FastAPI (非同期) |
| データベース | PostgreSQL 16 |
| ファイルストレージ | AWS S3 |
| AI エンジン | Anthropic Claude (`claude-opus-4-5`) |
| フロントエンド | バニラ HTML / CSS / JavaScript |
| 実行環境 | Docker Compose |

---

## アーキテクチャ

```
ブラウザ
  └── /static  (HTML / CSS / JS)
       └── API リクエスト (X-Tenant-Slug ヘッダー付き)
            └── FastAPI
                 ├── TenantMiddleware  ← テナント識別
                 ├── /api/invoices    ← 請求書管理
                 ├── /api/masters     ← 会社マスタ
                 └── /api/approvals   ← 承認管理
                      ├── PostgreSQL (スキーマ分離マルチテナント)
                      ├── AWS S3 (ファイルストレージ)
                      └── Anthropic API (AI 解析)
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
2. サブドメイン（例: `acme.example.com` → slug = `acme`）

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
| created_at | TIMESTAMP | 作成日時 |
| updated_at | TIMESTAMP | 更新日時 |

**ステータス一覧**

| 値 | 説明 |
|----|------|
| `processed` | AI 解析済 |
| `approved` | 承認済 |
| `rejected` | 却下 |

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
  1. S3 にアップロード（`tenants/{slug}/invoices/{uuid}.{ext}`）
  2. Claude AI でデータ抽出
  3. 会社マスタと照合（スコア 0.5 以上で自動紐付け）
  4. DB に保存（status: `processed`）
  5. 抽出データ + 照合候補を返却

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
| S3 キー形式 | `tenants/{slug}/invoices/{uuid}.{ext}` |
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

- **アップロードゾーン**: ドラッグ&ドロップまたはクリックでファイル選択
  - アップロード中は「アップロード・AI解析中...」を表示
  - 完了後、解析結果モーダルを自動表示
- **一覧テーブル**: ファイル名 / ステータス / 発行者 / 請求書番号 / 合計金額 / 登録日 / ストレージリンク / 操作
  - ストレージリンクボタン: S3 署名付き URL を取得して新タブで開く
  - ステータスフィルタ・テキスト検索対応
- **詳細モーダル**: 抽出データ全項目・明細行・照合スコアを表示
  - 「再解析」ボタンで再度 AI 解析を実行
  - 「承認依頼作成」ボタンで承認フローに遷移
- **編集モーダル**: ステータス・紐付け会社を手動変更

### 会社マスタ画面

- 会社一覧（名前・登録番号・住所・電話・メール）
- テキスト検索対応
- 新規登録 / 編集 / 削除

### 承認管理画面

- 承認レコード一覧（請求書ID / 承認者 / ステータス / コメント）
- ステータスフィルタ対応
- 承認依頼作成 / 承認 / 却下 / 削除

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
| `CLAUDE_MODEL` | — | `claude-opus-4-5` | 使用する Claude モデル ID |

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
├── app/
│   ├── main.py              # FastAPI アプリ定義・ルーター登録
│   ├── config.py            # 環境変数設定 (pydantic-settings)
│   ├── db.py                # DB セッション管理
│   ├── schemas.py           # Pydantic スキーマ
│   ├── middleware/
│   │   └── tenant.py        # テナント識別ミドルウェア
│   ├── routers/
│   │   ├── invoices.py      # 請求書 API
│   │   ├── masters.py       # 会社マスタ API
│   │   └── approvals.py     # 承認 API
│   ├── services/
│   │   ├── claude.py        # Claude AI 連携
│   │   └── s3.py            # AWS S3 連携
│   └── static/
│       ├── index.html       # SPA エントリポイント
│       ├── css/style.css    # スタイルシート
│       └── js/
│           ├── api.js       # API クライアント
│           ├── app.js       # アプリ起動・共通処理・SVG アイコン
│           ├── invoices.js  # 請求書画面ロジック
│           ├── masters.js   # 会社マスタ画面ロジック
│           └── approvals.js # 承認管理画面ロジック
├── migrations/
│   └── init.sql             # DB 初期化 SQL (テナントプロビジョニング関数含む)
├── terraform/               # インフラ定義 (AWS)
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── .env                     # 環境変数（Git 管理外）
```
