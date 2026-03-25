const path = require('path');

module.exports = {
  // The base directory for your markdown files
  markdownBaseDir: path.resolve('C:\\Sviluppo\\git\\Obsidian\\General\\Resources\\Credentials'),

  // The name of the folder where global attachments are stored
  attachmentsDir: path.resolve('C:\\Sviluppo\\git\\Obsidian\\General\\Attachments'),
  // Additional common global folders Obsidian users often use (checked as fallbacks)
  attachmentsDirs: ['Attachments', 'Images', 'images', 'assets', 'Pasted Images', 'Pasted images'],

  // Image upload mode: 'notion' (native Notion upload) or 'skip' (disable uploads)
  imageUpload: 'notion',  // Now using correct 2-step file upload API

  // Structure mode: 'databases' (current behavior) or 'pages' (nested pages like folders)
  structureMode: 'databases',

  // Update existing pages when source markdown changes
  updateExisting: false,

  // Auto watch for changes: 'off' | 'on'
  watchMode: 'off',
  // Debounce ms for watch mode
  watchDebounceMs: 1000,

  // The number of files to process concurrently
  concurrencyLimit: 3,

  // The name for the database that holds notes from the root directory
  rootDatabaseName: 'Root',
};
