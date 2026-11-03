# UE5 에디터 수동 FBX 가져오기

이 도구는 사용자가 만든 UE5 First Person Blueprint 프로젝트에 **거리 Static Mesh와 분할된 신영상가 참고 메시들**을 가져옵니다. UE 프로젝트 생성·레벨 구성·배치·캐릭터 구현·플레이 검증을 수행하지 않습니다.

1. 두 FBX가 저장소의 다음 위치에 있어야 합니다.
   - `exports/guil-street-ue5/guil-street.fbx`
   - `exports/shinyeong-ue5-transfer/shinyeong-v13-ue-groups.fbx`
2. UE5 Editor에서 Python Editor Script Plugin과 Editor Scripting Utilities를 활성화하고 필요한 경우 재시작합니다. PIE/플레이를 정지한 상태에서 실행합니다.
3. Output Log의 Python 입력에서 아래 명령을 실행합니다. `REPO_ROOT`는 위 `exports` 폴더가 있는 저장소 루트이며, 스크립트는 저장소의 `tools/import_guil_fbx.py`입니다.

```python
import runpy
runpy.run_path(r'C:\seoul_3Dgame\tools\import_guil_fbx.py', run_name='__main__', init_globals={'REPO_ROOT': r'C:\seoul_3Dgame'})
```

매번 `/Game/GuilImports/Run_<고유번호>/StreetDraft`와 `ShinyeongReference`에 저장합니다. 기존 폴더가 충돌하면 중단하고 덮어쓰기·삭제·레벨 편집을 하지 않습니다. 실패할 때 해당 새 폴더에 일부 자산이 남을 수 있으며 자동 정리하지 않습니다. 가져오기 전에 두 FBX의 존재·경로와 신영상가 원본·분할본의 해시, 재질 수가 검증 보고서와 맞는지 검사합니다.

거리 FBX는 하나의 메시로 합칩니다. 신영상가는 실제 사용 재질이 287개여서 UE FBX의 메시당 재질 제한을 피하도록 미리 여러 그룹으로 나누었으며, 가져올 때 다시 합치지 않습니다. FBX 노드의 절대 변환을 정점에 적용하고, 단위를 UE 센티미터로 변환하며 배율은 1입니다. 거리와 신영상가의 모든 조각을 레벨에 배치할 때 동일한 위치·회전·배율을 사용한 뒤 실제 크기와 정렬을 확인해야 합니다.

FBX의 재질·텍스처 가져오기를 요청합니다. 신영상가에 재질이 많으므로 가져오기가 오래 걸릴 수 있고, UE에서 표시가 제대로 되는지는 아직 확인하지 못했습니다. 자동 충돌은 생성하지 않습니다. 전체 거리 메쉬의 볼록 충돌이 통행로를 막을 수 있기 때문이며, 실제 보행용 충돌은 UE에서 별도 검증·설정해야 합니다. 원본 FBX에 사용자 충돌 메쉬가 있으면 가져오기 동작이 달라질 수 있습니다.

## 검증 범위

`python -B -m unittest discover -s tools -p test_import_guil_fbx.py -v`로 입력 검증, 기존 대상 거부, 덮어쓰기 금지 설정, 개별 실행 대상 분리, 실패·빈 결과 처리를 stub에서 확인합니다. 이 검증은 FBX 파일의 유효성이나 UE API 호환성을 증명하지 않습니다.

현재 PC에서 UE5 Editor를 찾지 못했으므로 `FbxFactory`, `FbxImportUI`, `AssetImportTask`, `AssetTools.import_asset_tasks`, `EditorAssetLibrary` 실제 호출은 미검증입니다. 버전별 FBX/Interchange 동작, 메쉬 합치기, 단위·축·정렬·피벗, 저장 결과, 렌더링·재질·충돌·1인칭 플레이도 UE에서 확인해야 합니다. 플러그인 또는 API가 없으면 오류를 내고 중단하며 다른 가져오기 방식으로 몰래 전환하지 않습니다.

## Blender에서 그룹 검증 재현

원본은 보존하고 결과를 저장소 안의 **새 경로**로 만듭니다. 기존 FBX나 보고서는 덮어쓰지 않습니다. Blender 5.2.2에서 검증했으며 설치 경로가 다르면 명령의 실행 파일 경로를 바꿉니다.

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python-exit-code 1 --python .\tools\group_shinyeong_v13.py -- --source .\exports\shinyeong-ue5-transfer\shinyeong-v13.fbx --output .\work\group-check\shinyeong.fbx
```

보고서와 FBX를 저장한 뒤 Blender에서 다시 읽어 비교합니다. 재생성 FBX의 해시는 바뀔 수 있으며 각 실행의 보고서와 대조합니다. 최초 검증 결과는 [그룹 검증 기록](../exports/shinyeong-ue5-transfer/grouping-verification.json)에 있습니다.

## 확인한 공식 API 문서

- [AssetImportTask (UE 5.6)](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/AssetImportTask?application_version=5.6): 동기 가져오기·덮어쓰기·저장·결과 경로 설정.
- [FbxImportUI (UE 5.6)](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/FbxImportUI?application_version=5.6): Static Mesh 선택과 재질·텍스처·애니메이션 옵션.
- [FbxStaticMeshImportData (UE 5.6)](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/FbxStaticMeshImportData?application_version=5.6): 합치기·절대 변환·단위·충돌 설정.
- [FbxFactory (UE 5.6)](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/FbxFactory?application_version=5.6): FBX 가져오기 팩토리.
- [AssetTools (UE 5.6)](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/AssetTools?application_version=5.6): 가져오기 작업 실행.
- [EditorAssetLibrary (UE 5.6)](https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/EditorAssetLibrary?application_version=5.6): 대상 폴더·자산 존재 확인, Editor Scripting Utilities 의존성.
- [FBX 가져오기 오류](https://dev.epicgames.com/documentation/unreal-engine/fbx-import-errors-in-unreal-engine): Static Mesh의 재질 수 제한과 분할 안내.

문서 확인일: 2026-11-03. 문서 버전은 호환성 기준이며 이 PC에 해당 버전이 설치되어 있다는 의미는 아닙니다.
