# 구일 2026 · UE5 1인 탐험

2026년 구일의 실제 지도 배치와 동네 분위기를 바탕으로, **미니어처풍의 1인칭 탐험 공간**을 만듭니다. 개발 엔진은 **Unreal Engine 5**이고, 우선 혼자 탐험하는 범위입니다. 2050년 재건축 계획과 기존 브라우저 게임은 현재 제작 방향에서 제외했습니다. 유료 에셋·플러그인·구독은 사용하지 않습니다.

## 현재 상태

**UE5 프로젝트와 실행 가능한 게임은 아직 없습니다.** 기존 지도를 배치 참고용 3D 선으로 변환하고, 이전 신영상가 외관을 편집 가능한 모델과 FBX로 보존했습니다. 아래 파일은 최종 게임이나 선택한 이미지 수준의 완성 그래픽이 아닙니다.

| 자료 | 용도 |
| --- | --- |
| [구일 2D 지도](docs/guro1_plan_2d.geojson) · [평면도](docs/reference/구로1동_2D평면도.svg) · [격자 조사](docs/reference/구로1동_격자조사.md) | 건물·도로·학교 위치와 기존 조사 기록 |
| [구일 지도 FBX](exports/guil-map-ue5-transfer/guil-map-reference.fbx) · [편집용 Blender 파일](exports/guil-map-ue5-transfer/guil-map-reference.blend) | 신영상가와 주변을 놓기 위한 배치 참고선 |
| [신영상가 FBX](exports/shinyeong-ue5-transfer/shinyeong-v13.fbx) · [편집용 Blender 파일](exports/shinyeong-ue5-transfer/shinyeong-v13.blend) | 기존 외관을 UE5에 가져와 다듬기 위한 출발점 |
| [지도 기준](docs/구일_지도_기준.md) · [신영상가 외관 기준](docs/신영상가_외관_기준.md) | 출처, 추정과 미확인 사항, 이전 조사 자료 |
| [집 작업 인수인계](docs/집_작업_인수인계.md) | 다른 PC에서 이어갈 순서와 확인 사항 |

지도·신영상가 FBX의 형상과 상대 위치는 Blender에서 확인했습니다. 신영상가 간판 텍스처 5개의 FBX 왕복도 확인했습니다. **UE5에서의 가져오기·재질·축·크기·충돌·성능은 아직 확인하지 않았습니다.** 신영상가 모델은 일부 가상 간판이 남아 있고, 상세 치수는 사진 비례 추정입니다. 맵의 선 두께는 실제 도로폭이 아닙니다.

## 집에서 받기

기존 `C:\seoul_3Dgame`이 있고 작업한 변경이 없다면 PowerShell에서 다음을 실행합니다.

```powershell
cd C:\seoul_3Dgame
git status --short --branch
git pull --ff-only origin main
```

`git status`에 변경이 있으면 덮어쓰지 말고 먼저 그 작업을 보존·확인합니다. 폴더가 없는 경우에는 `git clone https://github.com/1ritaron8/seoul_3Dgame.git C:\seoul_3Dgame`으로 받습니다. 이번 교체는 기존 Git 이력을 지우지 않은 일반 커밋입니다.

그다음 집 PC의 UE5 설치와 버전을 확인해 1인칭 프로젝트를 생성하고, 두 FBX를 가져와 크기·방향·상대 위치를 확인합니다. UE5 프로젝트를 생성하기 전에는 실행할 게임이 없습니다. 집 PC 목표는 FHD 120fps 이상이며 아직 UE5에서 측정하지 않았습니다.

## 지도 출처와 한계

2D 지도는 2026-09-30에 수집한 OpenStreetMap 기반 도형과 수기 추정을 포함합니다. [OpenStreetMap 기여자와 ODbL 1.0](https://www.openstreetmap.org/copyright)을 따릅니다. 지도 참고 FBX에는 2025년 국토지리정보원 1:1,000 수치지도에서 파생한 도로·보도 외곽선도 들어 있습니다. 2025년 자료와 2026년 지도는 시점이 다르며, 위치·경계·실측 정확도를 보증하지 않습니다. 원본 로드뷰 사진과 원본 수치지도 다운로드 파일은 포함하지 않았습니다.
