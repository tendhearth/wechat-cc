export interface MindNode {
  id: string
  topic: string
  direction?: 0 | 1
  branchColor?: string
  style?: { border: string }
  children?: MindNode[]
  parent?: MindNode
  tags?: string[]
}

export interface MindData { nodeData: MindNode }

export interface MindTopic extends HTMLElement { nodeObj: MindNode }
export interface MoveOperation {
  name: 'moveNodeIn' | 'moveNodeBefore' | 'moveNodeAfter'
  objs: MindNode[]
  toObj: MindNode
}

interface Options {
  el: HTMLDivElement
  direction: 2
  editable: boolean
  contextMenu: false
  toolBar: false
  keypress: false
  allowUndo: false
  before: Record<string, (from: MindTopic[], to: MindTopic) => boolean>
  theme: { name: string; type: 'light'; palette: string[]; cssVar: Record<string, string> }
}

export default class MindElixir {
  constructor(options: Options)
  init(data: MindData): void | Error
  destroy(): void
  refresh(data: MindData): void
  findEle(id: string): HTMLElement
  selectNode(element: HTMLElement): void
  move(dx: number, dy: number): void
  dragged: MindTopic[] | null
  scale(value: number): void
  scaleFit(): void
  toCenter(): void
  container: HTMLDivElement
  map: HTMLDivElement
  nodes: HTMLElement
  bus: {
    addListener(event: 'selectNodes' | 'unselectNodes', listener: (nodes: MindNode[]) => void): void
    addListener(event: 'operation', listener: (op: MoveOperation | { name: 'expandNode' }) => void): void
  }
}
