// ChatInput 的文本与光标原子更新 reducer。
//
// 输入缓冲区的所有修改都必须走 `useReducer(inputReducer)`。
// 这样一来，某个按键如果既要改文本又要移动光标，就会被合并成
// 一次状态迁移提交，避免中间态先改了文本但光标还停在旧位置的
// 那一帧闪现出来。

export interface InputState {
  text: string
  cursor: number
}

export type InputAction =
  | { type: 'INSERT'; pos: number; chunk: string }
  | { type: 'BACKSPACE_REF'; pos: number; deleteCount: number }
  | { type: 'DELETE'; pos: number }
  | { type: 'SET_CURSOR'; cursor: number }
  | { type: 'SET_TEXT'; text: string; cursor: number }
  | { type: 'RESET' }

export function inputReducer(state: InputState, action: InputAction): InputState {
  switch (action.type) {
    case 'INSERT': {
      const { pos, chunk } = action
      return {
        text: state.text.slice(0, pos) + chunk + state.text.slice(pos),
        cursor: pos + chunk.length,
      }
    }
    case 'BACKSPACE_REF': {
      const { pos, deleteCount } = action
      if (pos === 0) return state
      return {
        text: state.text.slice(0, pos - deleteCount) + state.text.slice(pos),
        cursor: pos - deleteCount,
      }
    }
    case 'DELETE': {
      const { pos } = action
      if (pos >= state.text.length) return state
      return { text: state.text.slice(0, pos) + state.text.slice(pos + 1), cursor: state.cursor }
    }
    case 'SET_CURSOR':
      return state.cursor === action.cursor ? state : { ...state, cursor: action.cursor }
    case 'SET_TEXT':
      return { text: action.text, cursor: action.cursor }
    case 'RESET':
      return { text: '', cursor: 0 }
    default:
      return state
  }
}
