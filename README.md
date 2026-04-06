<div align="center">
  <img src="https://github.com/utopiancreations/lezfindr/blob/main/banner.png" width="150" alt="LezFindr Logo">
  <h1>LezFindr</h1>
  <p><b>A community-centric dating and social app for lesbian, queer, and trans individuals.</b></p>
  
  [![Download on the App Store](https://img.shields.io/badge/Download_on_the-App_Store-black?style=for-the-badge&logo=apple)](https://apps.apple.com/us/app/lezfindr/id1560913928)
  [![Get it on Google Play](https://img.shields.io/badge/Get_it_on-Google_Play-black?style=for-the-badge&logo=google-play&logoColor=white)](https://play.google.com/store/apps/details?id=com.joshmiller.lezfindr)
</div>

---

## 📱 Project Overview
*Note: The source code for this application is proprietary and closed-source. This repository serves as an architectural overview and portfolio showcase.*

LezFindr is a fully realized, production-grade mobile application designed to foster genuine connections and build community beyond standard dating app mechanics. I managed the entire product lifecycle, utilizing a collaborative AI engineering workflow to design, architect, and execute the complete system.

## 🏗️ System Architecture & Evolution

To support scaling and global performance, the application infrastructure was custom-built on a modern serverless edge stack.

### Frontend Client
* **Framework**: Flutter
* **Language**: Dart
* **Design**: Custom UI/UX implementation focusing on accessibility and intuitive navigation.

### Edge Backend & Data Layer
* **API Infrastructure**: A globally distributed API built with the **Hono** framework and deployed on **Cloudflare Workers**.
* **Real-Time Systems**: **Cloudflare Durable Objects** managing stateful, low-latency WebSocket connections for instant messaging.
* **Primary Database**: **Neon Serverless PostgreSQL** handling all structured data including profiles, swipes, matches, and app events.
* **Object Storage**: **Cloudflare R2** for highly available media storage, including a dedicated, restricted sandbox bucket for content moderation and CSAM preservation.
* **Authentication**: **Firebase Auth** (JWT validation handled securely on the edge via `jose`).

## ✨ Core Features
1. **Edge-Optimized Real-Time Chat**: WebSockets routed through Durable Objects for immediate message delivery.
2. **Geolocation Services**: Radius-based querying for user discovery.
3. **Robust Content Moderation**: Integrated CSAM preservation, automated moderation flows, and admin reporting mechanisms.
4. **Secure Verification**: Verification protocols to ensure community safety and authenticity.

## 📸 Interface Preview


<div align="center">
  <img src="https://github.com/utopiancreations/lezfindr/blob/main/IDVerification.jpeg" width="200">
  <img src="https://github.com/utopiancreations/lezfindr/blob/main/grid.jpeg" width="200">
  <img src="https://github.com/utopiancreations/lezfindr/blob/main/Discovery.jpeg" width="200">
</div>
