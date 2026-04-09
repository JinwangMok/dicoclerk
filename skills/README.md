# DicoClerk — Openclaw Voice Meeting Recorder

Discord 음성 채널 회의를 녹취하고, 구조화된 회의록을 생성하여 PDF로 변환 후 Discord 채널에 전송하는 Openclaw 스킬 세트입니다.

## 아키텍처

```
[discord-voice 플러그인]  →  음성 캡처 + STT
        ↓
[dicoclerk 스킬]         →  /recording-start, /recording-stop (transcript 저장)
        ↓
[transcript-to-report]   →  transcript → 구조화된 회의록
        ↓
[report-to-pdf]          →  회의록 → PDF 변환
        ↓
[send-to-discord]        →  PDF → Discord 채널 전송
```

**핵심:** 음성 캡처/STT는 `discord-voice` 플러그인(avatarneil)이 담당하고, 회의록 생성 파이프라인은 dicoclerk 스킬 세트가 담당합니다.

---

## 셋업 가이드

### 1단계: discord-voice 플러그인 설치

discord-voice는 Discord 음성 캡처 + STT/TTS를 담당하는 TypeScript 코드 플러그인입니다.

```bash
# Openclaw 컨테이너에서 설치
docker exec democlaw-openclaw openclaw skills install discord-voice

# npm 의존성 설치
docker exec -u root democlaw-openclaw sh -c \
  'cd /home/openclaw/.openclaw/workspace/skills/discord-voice && npm install'
```

### 2단계: 시스템 의존성 설치

```bash
# ffmpeg (음성 처리 필수)
docker exec -u root democlaw-openclaw apt-get update -qq
docker exec -u root democlaw-openclaw apt-get install -y -qq ffmpeg

# pandoc + CJK 폰트 (PDF 변환용, 선택)
docker exec -u root democlaw-openclaw apt-get install -y -qq pandoc texlive-xetex fonts-noto-cjk
```

### 3단계: Openclaw 설정 (openclaw.json)

```bash
docker exec democlaw-openclaw node -e '
const fs = require("fs");
const path = "/home/openclaw/.openclaw/openclaw.json";
const c = JSON.parse(fs.readFileSync(path, "utf8"));

// 1. Discord voice 활성화
c.channels.discord.voice = {
  enabled: true,
  daveEncryption: true
};

// 2. 네이티브 명령어 활성화
if (!c.commands) c.commands = {};
c.commands.native = true;
c.channels.discord.commands = { native: true };

// 3. discord-voice 플러그인 설정
if (!c.plugins) c.plugins = {};
if (!c.plugins.entries) c.plugins.entries = {};
c.plugins.entries["discord-voice"] = {
  enabled: true,
  config: {
    sttProvider: "local-whisper",
    ttsProvider: "edge",
    ttsVoice: "nova",
    vadSensitivity: "medium",
    streamingSTT: false,
    bargeIn: false,
    allowedUsers: []
  }
};

fs.writeFileSync(path, JSON.stringify(c, null, 2));
console.log("Settings applied successfully");
'
```

**STT 프로바이더 옵션:**

| Provider | API 키 필요 | 특징 |
|----------|------------|------|
| `local-whisper` | 없음 (무료) | 오프라인, CPU 기반, 느림 |
| `deepgram` | `DEEPGRAM_API_KEY` | 실시간 스트리밍, 빠름 |
| `whisper` | `OPENAI_API_KEY` | OpenAI Whisper API |
| `gpt4o-transcribe` | `OPENAI_API_KEY` | 높은 품질 |
| `wyoming-whisper` | 없음 | 원격 Wyoming 서버 필요 |

**TTS 프로바이더 옵션 (봇 응답 음성용, 선택):**

| Provider | API 키 필요 | 특징 |
|----------|------------|------|
| `edge` | 없음 (무료) | Microsoft Edge TTS |
| `kokoro` | 없음 (무료) | 로컬 CPU 기반 |
| `openai` | `OPENAI_API_KEY` | 고품질 |
| `elevenlabs` | `ELEVENLABS_API_KEY` | 자연스러운 음성 |
| `deepgram` | `DEEPGRAM_API_KEY` | Deepgram Aura |

> **참고:** 회의 녹취만 원한다면 TTS는 `edge` (무료)로 설정하세요.

### 4단계: dicoclerk 스킬 세트 설치

```bash
# 수동 설치 (로컬 파일 복사)
docker cp skills/dicoclerk democlaw-openclaw:/home/openclaw/.openclaw/workspace/skills/
docker cp skills/transcript-to-report democlaw-openclaw:/home/openclaw/.openclaw/workspace/skills/
docker cp skills/report-to-pdf democlaw-openclaw:/home/openclaw/.openclaw/workspace/skills/
docker cp skills/send-to-discord democlaw-openclaw:/home/openclaw/.openclaw/workspace/skills/

# 권한 수정
docker exec -u root democlaw-openclaw chown -R openclaw:openclaw /home/openclaw/.openclaw/workspace/skills/
```

### 5단계: Discord Bot 권한 설정

Discord Developer Portal (https://discord.com/developers/applications)에서:

**Privileged Gateway Intents:**
- [x] Message Content Intent
- [x] Server Members Intent

**Bot Permissions:**
- [x] Connect (음성 채널 연결)
- [x] Speak (음성 채널 발화)
- [x] Send Messages (텍스트 메시지)
- [x] Attach Files (파일 전송)
- [x] Use Slash Commands

### 6단계: 재시작 및 확인

```bash
# Openclaw 재시작
docker restart democlaw-openclaw

# 30초 대기 후 스킬 확인
sleep 30
docker exec democlaw-openclaw openclaw skills list | grep -E "discord-voice|dicoclerk|transcript|report|send"
```

예상 결과:
```
✓ ready       discord-voice          Real-time voice conversations...
✓ ready       dicoclerk              Discord voice meeting recorder...
✓ ready       transcript-to-report   Convert a meeting transcript...
△ needs setup report-to-pdf          Convert a meeting report... (pandoc 필요)
✓ ready       send-to-discord        Send a meeting report PDF...
```

---

## 사용법

### 기본 회의 녹취 흐름

1. **음성 채널 참가** (Discord에서):
   ```
   /discord_voice join channel:<음성 채널 선택>
   ```
   또는:
   ```
   @OpenClaw_TestBot 디코봇STT 음성 채널에 참가해줘
   ```

2. **녹취 시작**:
   ```
   /dicoclerk
   ```
   또는:
   ```
   @OpenClaw_TestBot /recording-start
   ```

3. **회의 진행** (음성 대화 — discord-voice가 자동으로 STT 수행)

4. **녹취 종료**:
   ```
   @OpenClaw_TestBot /recording-stop
   ```
   → 자동으로: transcript → 회의록 → PDF → Discord 전송

### 개별 스킬 사용

```bash
# 기존 트랜스크립트로 회의록 생성
@OpenClaw_TestBot /transcript-to-report ~/.dicoclerk/transcripts/dicoclerk_2026-04-09_17-30.md

# 회의록을 PDF로 변환
@OpenClaw_TestBot /report-to-pdf ~/.dicoclerk/reports/report_2026-04-09_17-30.md

# PDF를 Discord로 전송
@OpenClaw_TestBot /send-to-discord ~/.dicoclerk/reports/report_2026-04-09_17-30.pdf
```

### 음성 채널 제어

```bash
# 참가
/discord_voice join channel:<채널>

# 상태 확인
/discord_voice status

# 퇴장
/discord_voice leave
```

---

## 파일 구조

```
~/.dicoclerk/
  config.json              # Discord 채널 설정 (자동 생성)
  .recording-active        # 녹취 중 락 파일
  transcripts/
    dicoclerk_YYYY-MM-DD_HH-MM.md    # 트랜스크립트
  reports/
    report_YYYY-MM-DD_HH-MM.md       # 회의록 마크다운
    report_YYYY-MM-DD_HH-MM.pdf      # 회의록 PDF
```

---

## 설정 체크리스트

- [ ] `discord-voice` 플러그인 설치 + npm install
- [ ] ffmpeg 설치
- [ ] `openclaw.json`에 voice 설정 추가
- [ ] `openclaw.json`에 discord-voice 플러그인 설정 추가
- [ ] `openclaw.json`에 `commands.native: true` 추가
- [ ] Discord Bot에 Server Members Intent 활성화
- [ ] Discord Bot에 Connect + Speak 권한
- [ ] 4개 dicoclerk 스킬 복사
- [ ] Openclaw 재시작
- [ ] `openclaw skills list`에서 5개 스킬 확인
- [ ] (선택) pandoc + CJK 폰트 설치 (PDF용)

---

## 문제 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| discord-voice "needs setup" | npm 미설치 또는 플러그인 설정 없음 | npm install + openclaw.json에 plugins.entries 추가 |
| `/discord_voice join` 안 됨 | 플러그인 미활성화 또는 권한 부족 | openclaw.json에 enabled: true + Discord 권한 확인 |
| STT가 안 됨 | STT 프로바이더 설정 오류 | local-whisper (무료) 또는 API 키 확인 |
| report-to-pdf "needs setup" | pandoc 미설치 | `apt install pandoc` |
| PDF 한글 깨짐 | CJK 폰트 없음 | `apt install fonts-noto-cjk texlive-xetex` |
| 봇이 음성 안 들어옴 | voice 설정 미활성화 | openclaw.json voice.enabled + 재시작 |
| `/vc join` 에러 | 내장 voice 기능 문제 | discord-voice 플러그인 사용 (`/discord_voice join`) |

---

## 스킬 구성

| 스킬 | 타입 | 설명 |
|------|------|------|
| `discord-voice` | **코드 플러그인** (avatarneil) | 음성 캡처 + STT + TTS |
| `dicoclerk` | SKILL.md | /recording-start, /recording-stop |
| `transcript-to-report` | SKILL.md | transcript → 구조화된 회의록 |
| `report-to-pdf` | SKILL.md | 회의록 → PDF (pandoc) |
| `send-to-discord` | SKILL.md | PDF → Discord 채널 전송 |
