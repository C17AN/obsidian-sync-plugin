# GitHub Vault Sync

![GitHub Vault Sync Banner](docs/banner.png)

Obsidian 노트를 GitHub 저장소와 동기화해서 PC와 모바일 같은 여러 환경의 Obsidian 사이에서 같은 글을 공유할 수 있는 플러그인입니다.  
`git` CLI 없이 GitHub REST API와 Obsidian Vault API만 사용하도록 설계했습니다.

## 주요 기능

- GitHub 저장소를 동기화 원격지로 사용
- 초기 `Pull` / 초기 `Push` 분리 지원
- 이후 변경분만 반영하는 증분 양방향 sync
- 충돌 발생 시 conflict 사본 생성
- 주기적인 자동 sync 지원
- 페이지 포커스를 잃을 때 자동 sync 지원
- 모바일 Obsidian 호환 고려
- `owner/repo`, 저장소 이름, 전체 GitHub URL 입력 지원

## 이런 경우에 적합합니다

- PC와 모바일에서 같은 Obsidian 글을 이어서 작성하고 싶을 때
- Obsidian Vault 전체를 GitHub 기반으로 가볍게 공유하고 싶을 때
- 별도 Git 클라이언트 없이 노트 중심으로 동기화하고 싶을 때

## 설치

1. `npm install`
2. `npm run build`
3. `dist/` 안의 파일을 Obsidian vault의 `.obsidian/plugins/github-vault-sync/`에 복사
4. Obsidian Community Plugins에서 활성화

### 설치 스크립트

- Windows에서는 `install.bat`를 실행하거나 `scripts/install.ps1`를 직접 실행할 수 있습니다.
- 또는 `npm run install:obsidian` 실행 후 vault 경로를 입력하면 `dist/` 파일이 자동으로 `.obsidian/plugins/github-vault-sync/`로 복사됩니다.

## 설정 항목

- `GitHub Owner`
- `GitHub Repository`
- `Branch`
- `Personal Access Token`
- `Repository Base Path`
- `Vault Base Path`
- `Auto Sync On Focus Loss`
- `Auto Sync Interval (minutes)`
- `Sync On Startup`

## Conflict 안내

PC와 모바일에서 같은 문서를 거의 동시에 수정하거나, 두 기기에서 sync가 겹치면 conflict가 생길 수 있습니다.  
이 경우 플러그인은 기존 문서를 바로 덮어쓰지 않고 `*.conflict-*` 파일을 따로 만들어 내용을 보존합니다.

다음 상황에서는 conflict 가능성이 높습니다.

- 모바일에서 문서를 열어둔 상태로 PC에서 같은 문서를 수정한 경우
- PC와 모바일에서 같은 문서를 짧은 시간 차이로 모두 수정한 경우
- 두 기기에서 자동 sync가 거의 동시에 실행된 경우

## Conflict가 생기면

1. 원본 문서와 `*.conflict-*` 문서를 같이 확인합니다.
2. 둘 중 유지할 내용을 원본 문서에 수동으로 반영합니다.
3. 정리가 끝나면 다시 sync를 실행합니다.
4. 더 이상 필요 없는 conflict 문서는 직접 삭제합니다.

가장 안전한 방법은 한 기기에서 수정한 뒤 sync가 끝난 것을 확인하고, 다른 기기에서 이어서 수정하는 것입니다.  
같은 문서를 두 기기에서 동시에 열어두고 편집하는 사용 방식은 가능한 피하는 편이 좋습니다.

## 모바일 지원

이 플러그인은 `isDesktopOnly: false`로 구성되어 있으며 GitHub API와 Obsidian API만 사용합니다.  
즉 모바일 Obsidian에서도 커뮤니티 플러그인을 사용할 수 있는 환경이라면 같은 방식으로 동작할 수 있습니다.
