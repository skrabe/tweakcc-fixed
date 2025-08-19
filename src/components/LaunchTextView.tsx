import { useState, useEffect, useContext } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import figlet from 'figlet';
import { getCurrentClaudeCodeTheme } from '../utils/misc.js';
import { SettingsContext } from '../App.js';
import Header from './Header.js';

interface LaunchTextViewProps {
  onBack: () => void;
}

// Will be populated with all available fonts
let FIGLET_FONTS: string[] = ['ANSI Shadow']; // Default fallback

export function LaunchTextView({ onBack }: LaunchTextViewProps) {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || 120;

  const {
    settings: {
      launchText: { method, figletText, figletFont, customText },
      themes,
    },
    updateSettings,
  } = useContext(SettingsContext);

  const options =
    method === 'figlet'
      ? (['method', 'text', 'font'] as const)
      : (['method', 'text'] as const);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0);
  const selectedOption = options[selectedOptionIndex];
  const [selectedMethodIndex, setSelectedMethodIndex] = useState(
    method === 'figlet' ? 0 : 1
  );
  const [availableFonts, setAvailableFonts] = useState<string[]>(FIGLET_FONTS);
  const [filteredFonts, setFilteredFonts] = useState<string[]>(FIGLET_FONTS);
  const [fontFilter, setFontFilter] = useState('');
  const [isFilteringFonts, setIsFilteringFonts] = useState(false);
  const [selectedFontIndex, setSelectedFontIndex] = useState(0);
  const [preview, setPreview] = useState('');
  const [previewWidth, setPreviewWidth] = useState(50);
  const [editingText, setEditingText] = useState(false);
  const [textInput, setTextInput] = useState(
    method === 'figlet' ? figletText : customText
  );

  // Get current Claude theme and color
  const currentThemeId = getCurrentClaudeCodeTheme();
  const currentTheme =
    themes.find(t => t.id === currentThemeId) ||
    themes.find(t => t.id === 'dark');
  const claudeColor = currentTheme?.colors.claude || 'rgb(215,119,87)';

  // Load available fonts on component mount
  useEffect(() => {
    figlet.fonts((err, fonts) => {
      if (!err && fonts) {
        const sortedFonts = fonts.sort();
        setAvailableFonts(sortedFonts);
        setFilteredFonts(sortedFonts);
        FIGLET_FONTS = sortedFonts;

        // Set initial font index
        const fontIndex = sortedFonts.indexOf(
          figletFont as unknown as figlet.Fonts
        );
        setSelectedFontIndex(
          fontIndex >= 0 ? fontIndex : sortedFonts.indexOf('ANSI Shadow') || 0
        );
      }
    });
  }, []);

  useEffect(() => {
    updatePreview();
  }, [method, figletText, figletFont, customText, textInput, editingText]);

  const updatePreview = () => {
    if (method === 'figlet') {
      try {
        const textToUse = editingText ? textInput : figletText;
        const result = figlet.textSync(textToUse.replace('\n', ' '), {
          font: figletFont as unknown as figlet.Fonts,
        });

        // Truncate long lines and calculate preview width
        const availablePreviewWidth = Math.floor(terminalWidth * 0.7); // 60% of terminal for preview
        const lines = result.split('\n');
        const truncatedLines = lines.map(line =>
          line.length > availablePreviewWidth
            ? line.substring(0, availablePreviewWidth - 3) + '\u2026'
            : line
        );
        const truncatedResult = truncatedLines.join('\n');
        setPreview(truncatedResult);

        // Calculate width based on truncated content
        const maxTruncatedLineLength = Math.max(
          ...truncatedLines.map(line => line.length)
        );
        const widthPercentage = Math.min(
          75,
          Math.max(
            50,
            Math.ceil((maxTruncatedLineLength / terminalWidth) * 100)
          )
        );
        setPreviewWidth(widthPercentage + 5);
      } catch {
        setPreview('Error generating figlet text');
        setPreviewWidth(50);
      }
    } else {
      const availablePreviewWidth = Math.floor(terminalWidth * 0.6);
      const textToUse = editingText ? textInput : customText;
      const lines = textToUse.split('\n');
      const truncatedLines = lines.map(line =>
        line.length > availablePreviewWidth
          ? line.substring(0, availablePreviewWidth - 3) + '...'
          : line
      );
      const truncatedResult = truncatedLines.join('\n');
      setPreview(truncatedResult);

      const maxTruncatedLineLength = Math.max(
        ...truncatedLines.map(line => line.length)
      );
      const widthPercentage = Math.min(
        75,
        Math.max(50, Math.ceil((maxTruncatedLineLength / terminalWidth) * 100))
      );
      setPreviewWidth(widthPercentage + 5);
    }
  };

  // Filter fonts when fontFilter changes
  useEffect(() => {
    if (fontFilter) {
      const filtered = availableFonts.filter(font =>
        font.toLowerCase().includes(fontFilter.toLowerCase())
      );
      setFilteredFonts(filtered);
      setSelectedFontIndex(0); // Reset to first filtered result
    } else {
      setFilteredFonts(availableFonts);
      // Restore original position if possible
      const fontIndex = availableFonts.indexOf(figletFont);
      setSelectedFontIndex(fontIndex >= 0 ? fontIndex : 0);
    }
  }, [fontFilter, availableFonts]);

  // Only update selectedFontIndex when figletFont changes from outside (not during filtering)
  useEffect(() => {
    if (!isFilteringFonts) {
      const fontIndex = filteredFonts.indexOf(figletFont);
      if (fontIndex >= 0) {
        setSelectedFontIndex(fontIndex);
      }
    }
  }, [figletFont, filteredFonts, isFilteringFonts]);

  useInput((input, key) => {
    if (editingText) {
      if (key.return) {
        // Save text input
        if (method === 'figlet') {
          updateSettings(settings => {
            settings.launchText.figletText = textInput;
          });
        } else {
          updateSettings(settings => {
            settings.launchText.customText = textInput;
          });
        }
        setEditingText(false);
      } else if (key.escape) {
        // Cancel text editing
        setTextInput(method === 'figlet' ? figletText : customText);
        setEditingText(false);
      } else if (key.backspace || key.delete) {
        setTextInput(prev => prev.slice(0, -1));
      } else if (input) {
        setTextInput(prev => prev + input);
      }
      return;
    }

    if (isFilteringFonts) {
      if (key.return) {
        // Apply selected filtered font
        if (filteredFonts.length > 0) {
          updateSettings(settings => {
            settings.launchText.figletFont = filteredFonts[selectedFontIndex];
          });
        }
        setIsFilteringFonts(false);
        setFontFilter('');
      } else if (key.escape) {
        // Cancel filtering
        setIsFilteringFonts(false);
        setFontFilter('');
      } else if (key.backspace || key.delete) {
        setFontFilter(prev => prev.slice(0, -1));
      } else if (key.upArrow) {
        const newIndex =
          selectedFontIndex > 0
            ? selectedFontIndex - 1
            : filteredFonts.length - 1;
        setSelectedFontIndex(newIndex);
        if (filteredFonts.length > 0) {
          updateSettings(settings => {
            settings.launchText.figletFont = filteredFonts[newIndex];
          });
        }
      } else if (key.downArrow) {
        const newIndex =
          selectedFontIndex < filteredFonts.length - 1
            ? selectedFontIndex + 1
            : 0;
        setSelectedFontIndex(newIndex);
        if (filteredFonts.length > 0) {
          updateSettings(settings => {
            settings.launchText.figletFont = filteredFonts[newIndex];
          });
        }
      } else if (input && input.match(/^[a-zA-Z0-9\s\-_]$/)) {
        setFontFilter(prev => prev + input);
      }
      return;
    }

    if (key.escape) {
      onBack();
    } else if (key.return) {
      if (selectedOption === 'text') {
        setTextInput(method === 'figlet' ? figletText : customText);
        setEditingText(true);
      }
    } else if (key.tab) {
      if (key.shift) {
        // Shift+Tab: go backwards
        setSelectedOptionIndex(prev =>
          prev === 0 ? options.length - 1 : prev - 1
        );
      } else {
        // Tab: go forwards
        setSelectedOptionIndex(prev =>
          prev === options.length - 1 ? 0 : prev + 1
        );
      }
    } else if (key.upArrow) {
      if (selectedOption === 'method') {
        const newIndex = selectedMethodIndex > 0 ? selectedMethodIndex - 1 : 1;
        setSelectedMethodIndex(newIndex);
        updateSettings(settings => {
          settings.launchText.method = newIndex === 0 ? 'figlet' : 'custom';
        });
      } else if (selectedOption === 'font' && method === 'figlet') {
        const newIndex =
          selectedFontIndex > 0
            ? selectedFontIndex - 1
            : filteredFonts.length - 1;
        setSelectedFontIndex(newIndex);
        updateSettings(settings => {
          settings.launchText.figletFont = filteredFonts[newIndex];
        });
      }
    } else if (key.downArrow) {
      if (selectedOption === 'method') {
        const newIndex = selectedMethodIndex < 1 ? selectedMethodIndex + 1 : 0;
        setSelectedMethodIndex(newIndex);
        updateSettings(settings => {
          settings.launchText.method = newIndex === 0 ? 'figlet' : 'custom';
        });
      } else if (selectedOption === 'font' && method === 'figlet') {
        const newIndex =
          selectedFontIndex < filteredFonts.length - 1
            ? selectedFontIndex + 1
            : 0;
        setSelectedFontIndex(newIndex);
        updateSettings(settings => {
          settings.launchText.figletFont = filteredFonts[newIndex];
        });
      }
    } else if (
      input &&
      selectedOption === 'font' &&
      method === 'figlet' &&
      input.match(/^[a-zA-Z0-9]$/)
    ) {
      // Start filtering when typing on font option
      setIsFilteringFonts(true);
      setFontFilter(input);
    }
  });

  return (
    <Box>
      <Box flexDirection="column" width={`${100 - previewWidth}%`}>
        <Box marginBottom={1} flexDirection="column">
          <Header>Setup banner</Header>
          <Box flexDirection="column">
            <Text dimColor>
              enter to {selectedOption === 'text' ? 'edit text' : 'save'}
            </Text>
            <Text dimColor>esc to go back</Text>
            <Text dimColor>tab to switch sections</Text>
          </Box>
        </Box>

        <Box>
          <Text>
            <Text color={selectedOption === 'method' ? 'yellow' : undefined}>
              {selectedOption === 'method' ? '❯ ' : '  '}
            </Text>
            <Text
              bold
              color={selectedOption === 'method' ? 'yellow' : undefined}
            >
              Method
            </Text>
          </Text>
        </Box>

        {selectedOption === 'method' && (
          <Text dimColor>
            {'  '}select one of {filteredFonts.length} Figlet fonts or enter
            your own text
          </Text>
        )}

        <Box marginLeft={2} marginBottom={1}>
          <Box flexDirection="column">
            <Text color={selectedMethodIndex === 0 ? 'cyan' : 'white'}>
              {selectedMethodIndex === 0 ? '❯ ' : '  '}Figlet
            </Text>
            <Text color={selectedMethodIndex === 1 ? 'cyan' : 'white'}>
              {selectedMethodIndex === 1 ? '❯ ' : '  '}Custom
            </Text>
          </Box>
        </Box>

        <Box flexDirection="column">
          <Text>
            <Text color={selectedOption === 'text' ? 'yellow' : undefined}>
              {selectedOption === 'text' ? '❯ ' : '  '}
            </Text>
            <Text bold color={selectedOption === 'text' ? 'yellow' : undefined}>
              Text
            </Text>
          </Text>
          {selectedOption === 'text' &&
            (editingText ? (
              <Text dimColor>{'  '}esc to save</Text>
            ) : (
              <Text dimColor>{'  '}enter to edit</Text>
            ))}
        </Box>

        <Box marginLeft={2} marginBottom={1}>
          <Box
            borderStyle="round"
            borderColor={editingText ? 'yellow' : 'gray'}
          >
            <Text>
              {editingText
                ? textInput
                : method === 'figlet'
                  ? figletText
                  : customText}
            </Text>
          </Box>
        </Box>

        {method === 'figlet' && (
          <>
            <Box>
              <Box flexDirection="column">
                <Text>
                  <Text
                    color={selectedOption === 'font' ? 'yellow' : undefined}
                  >
                    {selectedOption === 'font' ? '❯ ' : '  '}
                  </Text>
                  <Text
                    bold
                    color={selectedOption === 'font' ? 'yellow' : undefined}
                  >
                    Font
                  </Text>
                </Text>

                {selectedOption === 'font' && (
                  <Text dimColor>{'  '}type to filter</Text>
                )}
                <Text>
                  {isFilteringFonts && (
                    <Text color="gray" dimColor>
                      {'  '}
                      (filtering: &ldquo;{fontFilter}&rdquo;)
                    </Text>
                  )}
                </Text>
              </Box>
            </Box>

            <Box marginLeft={2} marginBottom={1}>
              <Box flexDirection="column">
                {(() => {
                  const maxVisible = 8; // Show 8 fonts at a time
                  const startIndex = Math.max(
                    0,
                    selectedFontIndex - Math.floor(maxVisible / 2)
                  );
                  const endIndex = Math.min(
                    filteredFonts.length,
                    startIndex + maxVisible
                  );
                  const adjustedStartIndex = Math.max(0, endIndex - maxVisible);

                  const visibleFonts = filteredFonts.slice(
                    adjustedStartIndex,
                    endIndex
                  );

                  return (
                    <>
                      {adjustedStartIndex > 0 && (
                        <Text color="gray" dimColor>
                          {' '}
                          ↑ {adjustedStartIndex} more above
                        </Text>
                      )}
                      {visibleFonts.map((font, visibleIndex) => {
                        const actualIndex = adjustedStartIndex + visibleIndex;
                        return (
                          <Text
                            key={font}
                            color={
                              selectedFontIndex === actualIndex
                                ? 'cyan'
                                : undefined
                            }
                          >
                            {selectedFontIndex === actualIndex ? '❯ ' : '  '}
                            {font}
                          </Text>
                        );
                      })}
                      {endIndex < filteredFonts.length && (
                        <Text color="gray" dimColor>
                          {' '}
                          ↓ {filteredFonts.length - endIndex} more below
                        </Text>
                      )}
                    </>
                  );
                })()}
              </Box>
            </Box>
          </>
        )}
      </Box>

      <Box width={`${previewWidth}%`} flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Preview</Text>
        </Box>
        <Box
          borderStyle="single"
          borderColor="gray"
          padding={1}
          flexDirection="column"
        >
          <Box flexDirection="column" marginBottom={1}>
            <Text color={claudeColor}>╭──────────────────────────╮</Text>
            <Text>
              <Text color={claudeColor}>│ ✻</Text> Welcome to Claude Code{' '}
              <Text color={claudeColor}>│</Text>
            </Text>
            <Text color={claudeColor}>╰──────────────────────────╯</Text>
          </Box>

          {preview.split('\n').map((line, index) => (
            <Text key={index} color={claudeColor}>
              {line}
            </Text>
          ))}

          <Box marginTop={1}>
            <Text wrap="truncate-end">
              Claude Code can now be used with your Claude subscription or
              billed based on API usage through your Console account.
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
