export type {
  RmFileFormat,
  DocumentType,
  ReMarkableDocument,
  ExtractedHighlight,
  ExtractionResult,
  DocumentDiscovery,
  HighlightExtractor,
  MarkdownRenderer,
  PipelineConfig,
  PipelineDependencies,
} from './types';

export {
  detectRmFormat,
  detectRmFormatFromFile,
  isFormatSupported,
  getParserForFormat,
  HEADER_READ_SIZE,
} from './format-detector';

// Sprint 3: Document discovery
export {
  discoverDocuments,
  XochitlDocumentDiscovery,
} from './document-discovery';

// Sprint 3: Python bridge
export {
  runPythonExtraction,
  resolveScriptPath,
  detectPythonPath,
  checkPythonDependencies,
  PythonHighlightExtractor,
} from './python-bridge';
export type {
  PythonExtractionOutput,
  PythonDocumentResult,
  PythonHighlight,
  ExtractionOptions,
} from './python-bridge';

// Sprint 3: Markdown rendering
export {
  renderMarkdown,
  mergeWithExistingNote,
  generateOutputFilename,
  DefaultMarkdownRenderer,
  HIGHLIGHTS_SECTION_START,
  HIGHLIGHTS_SECTION_END,
} from './markdown-renderer';
export type {
  RenderMarkdownOptions,
} from './markdown-renderer';

// Sprint 3: Pipeline orchestrator
export {
  runExtractionPipeline,
  createDefaultDependencies,
} from './extraction-pipeline';
export type {
  PipelineRunResult,
  DocumentPipelineResult,
  PipelineProgressCallback,
  DefaultDependenciesConfig,
} from './extraction-pipeline';

// Sprint 9: File watcher
export {
  XochitlFileWatcher,
} from './file-watcher';
export type {
  FileWatcherEvent,
  FileWatcherCallback,
  FileWatcherConfig,
} from './file-watcher';

// Sprint 6: Template engine
export {
  renderTemplate,
  buildTemplateContext,
  formatPdfLink,
  validateTemplate,
  TemplateMarkdownRenderer,
  DEFAULT_TEMPLATE,
} from './template-engine';
export type {
  TemplateContext,
  HighlightTemplateContext,
  PageTemplateEntry,
} from './template-engine';
