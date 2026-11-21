export interface MindNode {
  id: string
  topic: string
  direction?: 0 | 1
  branchColor?: string
  style?: { border: string }
  children?: MindNode[]
}

export interface MindData { nodeData: MindNode }

interface Options {
  el: HTMLDivElement
  direction: 2
  editable: false
  contextMenu: false
  toolBar: false
  keypress: false
  allowUndo: false
  before: Record<string, () => false>
  theme: { name: string; type: 'light'; palette: string[]; cssVar: Record<string, string> }
}

export default class MindElixir {
  constructor(options: Options)
  init(data: MindData): void | Error
  destroy(): void
  refresh(data: MindData): void
  findEle(id: string): HTMLElement
  selectNode(element: HTMLElement): void
  scale(value: number): void
  scaleFit(): void
  toCenter(): void
  container: HTMLDivElement
  map: HTMLDivElement
  nodes: HTMLElement
  bus: { addListener(event: 'selectNodes' | 'unselectNodes', listener: (nodes: MindNode[]) => void): void }
}
