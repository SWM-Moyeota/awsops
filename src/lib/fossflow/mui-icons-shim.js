// fossflow does `require("@mui/icons-material")`, which makes webpack compile and
// minify all ~10,600 icon modules (30 min build on t4g.xlarge). next.config.mjs
// aliases the bare specifier to this file, which re-exports only the icons
// fossflow@1.0.5 actually references. After upgrading fossflow, re-check with:
//   grep -o 'Si\.[A-Z][A-Za-z]*' node_modules/fossflow/dist/index.js | sort -u
// (`Si` is the minified binding of the require; it may be renamed in a new build.)
// fossflow가 아이콘 패키지 전체를 require해서 빌드가 30분 걸리던 문제의 우회 — 실제 사용하는 26개만 재수출.
export { default as Add } from '@mui/icons-material/Add';
export { default as AddOutlined } from '@mui/icons-material/AddOutlined';
export { default as ChevronLeft } from '@mui/icons-material/ChevronLeft';
export { default as ChevronRight } from '@mui/icons-material/ChevronRight';
export { default as Close } from '@mui/icons-material/Close';
export { default as CropFreeOutlined } from '@mui/icons-material/CropFreeOutlined';
export { default as CropSquareOutlined } from '@mui/icons-material/CropSquareOutlined';
export { default as DataObject } from '@mui/icons-material/DataObject';
export { default as DeleteOutline } from '@mui/icons-material/DeleteOutline';
export { default as DeleteOutlined } from '@mui/icons-material/DeleteOutlined';
export { default as EastOutlined } from '@mui/icons-material/EastOutlined';
export { default as ExpandLess } from '@mui/icons-material/ExpandLess';
export { default as ExpandMore } from '@mui/icons-material/ExpandMore';
export { default as FolderOpen } from '@mui/icons-material/FolderOpen';
export { default as GitHub } from '@mui/icons-material/GitHub';
export { default as ImageOutlined } from '@mui/icons-material/ImageOutlined';
export { default as Menu } from '@mui/icons-material/Menu';
export { default as NearMeOutlined } from '@mui/icons-material/NearMeOutlined';
export { default as PanToolOutlined } from '@mui/icons-material/PanToolOutlined';
export { default as QuestionAnswer } from '@mui/icons-material/QuestionAnswer';
export { default as Redo } from '@mui/icons-material/Redo';
export { default as Remove } from '@mui/icons-material/Remove';
export { default as Search } from '@mui/icons-material/Search';
export { default as TextRotationNone } from '@mui/icons-material/TextRotationNone';
export { default as Title } from '@mui/icons-material/Title';
export { default as Undo } from '@mui/icons-material/Undo';
