# Al-Qadhi Store — Telegram Bot Service

بوت تيليجرام لإدارة طلبات متجر القاضي.

## المميزات

- تأكيد/رفض الدفعات المحلية مع إدارة المخزون
- تتبع الشحنات
- إدارة المديرين
- إشعارات فورية للطلبات الجديدة
- لوحة مفاتيح تفاعلية + أزرار Inline

## المتطلبات

- Node.js 20+
- Bun (للتشغيل المحلي)
- قاعدة بيانات PostgreSQL (Supabase)

## التشغيل المحلي

```bash
# تثبيت الاعتمادات
npm install

# نسخ ملف البيئة
cp .env.example .env
# عدّل .env وضع القيم الحقيقية

# توليد Prisma Client
npm run generate

# تشغيل البوت
npm start
```

## متغيرات البيئة

| المتغير | الوصف | مطلوب |
|---------|-------|-------|
| `TELEGRAM_BOT_TOKEN` | توكن بوت تيليجرام | ✅ |
| `TELEGRAM_ADMIN_CHAT_ID` | معرف المحادثة الإدارية | ✅ |
| `SUPABASE_DATABASE_URL` | رابط قاعدة البيانات (pooler) | ✅ |
| `SUPABASE_DIRECT_URL` | رابط قاعدة البيانات (مباشر) | ✅ |
| `API_BASE_URL` | رابط موقع المتجر | ✅ |
| `INTERNAL_API_SECRET` | المفتاح السري للـ API الداخلي | ✅ |
| `NODE_ENV` | بيئة التشغيل | ❌ |

## النشر على Railway

1. ارفع المستودع على GitHub
2. أنشئ مشروع جديد في [Railway](https://railway.app)
3. اختر "Deploy from GitHub repo"
4. أضف متغيرات البيئة من `.env.example`
5. اختر المنفذ: `3099`

## البنية

```
alqadhi-bot-service/
├── index.ts          ← كود البوت الرئيسي (Telegraf)
├── start.mjs         ← نقطة الدخول ESM
├── prisma/
│   └── schema.prisma ← مخطط قاعدة البيانات
├── package.json
├── .env.example      ← قالب متغيرات البيئة
└── tsconfig.json
```
