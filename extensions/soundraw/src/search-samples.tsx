import { useState, useEffect, useRef } from "react";
import { Form, ActionPanel, Action, showToast, List, Icon, Toast } from "@raycast/api";
import { useForm, useCachedPromise } from "@raycast/utils";
import { searchSamples, getAvailableGenres, SoundrawAPIError } from "./lib/soundraw";
import { Sample } from "./lib/types";
import { usePlaybackState } from "./lib/hooks";
import { cleanupPlayback, playAudio, stopAudio } from "./lib/audio";
import { CopyFileAction } from "./components/CopyFileAction";
import { CopyUrlAction } from "./components/CopyUrlAction";
import { OpenInBrowserAction } from "./components/OpenInBrowserAction";
import { PlayStopAction } from "./components/PlayStopAction";
import { getOrDownloadFile, getExpectedFilePath } from "./lib/file";
import * as fs from "fs";

type Values = {
  genres: string[];
};

function SampleItem({ sample, filePath }: { sample: Sample; filePath: string | null }) {
  const [isDownloading, setIsDownloading] = useState(false);
  const isPlaying = usePlaybackState(sample.id);

  // Verify file exists before setting quickLook (files might not be ready yet)
  const verifiedFilePath = filePath && fs.existsSync(filePath) ? filePath : null;

  return (
    <List.Item
      id={sample.id}
      key={sample.id}
      title={sample.name}
      subtitle={sample.bpm ? `${sample.bpm} BPM` : ""}
      icon={isDownloading ? Icon.Clock : isPlaying ? Icon.SpeakerOn : Icon.Music}
      accessories={[...(sample.bpm ? [{ text: `${sample.bpm} BPM`, icon: Icon.Clock }] : [])]}
      quickLook={verifiedFilePath ? { path: verifiedFilePath } : undefined}
      actions={
        <ActionPanel>
          <CopyFileAction sample={sample} onLoadingChange={setIsDownloading} />
          <CopyUrlAction sample={sample} />
          <OpenInBrowserAction sample={sample} />
          <PlayStopAction sample={sample} />
        </ActionPanel>
      }
    />
  );
}

function SamplesList({
  samples,
  isLoading,
  onNewSearch,
  selectedGenres,
  availableGenres,
}: {
  samples: Sample[];
  isLoading: boolean;
  onNewSearch: () => void;
  selectedGenres: string[];
  availableGenres: Record<string, string>;
}) {
  const genreNames = selectedGenres.map((key) => availableGenres[key] || key).join(", ");
  const navigationTitle = genreNames ? `Search Samples: ${genreNames}` : "Search Samples";
  const selectedSampleIdRef = useRef<string | null>(null);
  const [filePaths, setFilePaths] = useState<Record<string, string>>({});
  const [isPreparingFiles, setIsPreparingFiles] = useState(false);

  // Prepare all sample files for drag and drop when samples change
  useEffect(() => {
    let cancelled = false;

    const prepareFiles = async () => {
      if (samples.length === 0) {
        setFilePaths({});
        setIsPreparingFiles(false);
        return;
      }

      setIsPreparingFiles(true);
      console.debug(`[drag-drop] preparing ${samples.length} files for drag and drop`);

      // Use Promise.allSettled to ensure all files are attempted even if some fail
      const preparePromises = samples.map(async (sample) => {
        try {
          // Check if file already exists (from previous play/copy action)
          const expectedPath = getExpectedFilePath(sample.sample, sample.name, null, "/tmp");
          if (fs.existsSync(expectedPath)) {
            // Verify file is readable and has content
            const stats = fs.statSync(expectedPath);
            if (stats.size > 0) {
              console.debug(`[drag-drop] file exists: ${sample.name} (${stats.size} bytes)`);
              return { sampleId: sample.id, path: expectedPath };
            } else {
              console.debug(`[drag-drop] file exists but is empty, re-downloading: ${sample.name}`);
            }
          }

          // Download and cache if needed (uses cache if available)
          const { path } = await getOrDownloadFile(sample.sample, "/tmp", sample.name);
          
          // Verify file was created successfully
          if (fs.existsSync(path)) {
            const stats = fs.statSync(path);
            if (stats.size > 0) {
              console.debug(`[drag-drop] file ready: ${sample.name} (${stats.size} bytes)`);
              return { sampleId: sample.id, path };
            } else {
              console.debug(`[drag-drop] file created but is empty: ${sample.name}`);
              return null;
            }
          } else {
            console.debug(`[drag-drop] file was not created: ${sample.name}`);
            return null;
          }
        } catch (error) {
          console.debug(
            `[drag-drop] failed to prepare file for ${sample.name}: ${error instanceof Error ? error.message : "Unknown error"}`,
          );
          return null;
        }
      });

      const results = await Promise.allSettled(preparePromises);
      
      if (cancelled) {
        return;
      }

      // Build paths object from successful results
      const paths: Record<string, string> = {};
      results.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value) {
          paths[result.value.sampleId] = result.value.path;
        } else if (result.status === "rejected") {
          console.debug(`[drag-drop] promise rejected for sample ${samples[index]?.name}`);
        }
      });

      setFilePaths(paths);
      setIsPreparingFiles(false);
      console.debug(`[drag-drop] prepared ${Object.keys(paths).length}/${samples.length} files`);
    };

    prepareFiles();

    return () => {
      cancelled = true;
    };
  }, [samples]);

  const handleSelectionChange = async (selectedId: string | null) => {
    // If no selection or same sample, do nothing
    if (!selectedId || selectedId === selectedSampleIdRef.current) {
      return;
    }

    console.debug(`[audio] selection changed: ${selectedId} (was: ${selectedSampleIdRef.current})`);
    selectedSampleIdRef.current = selectedId;

    try {
      // Stop currently playing sample
      await stopAudio();

      // Find the selected sample and play it
      const selectedSample = samples.find((s) => s.id === selectedId);
      if (selectedSample) {
        console.debug(`[audio] auto-playing selected sample: ${selectedSample.name}`);
        await playAudio(selectedSample.sample, selectedSample.id, selectedSample.name);
      }
    } catch (error) {
      console.debug(
        `[audio] failed to auto-play selected sample: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      // Don't show toast for auto-play failures, just log
    }
  };

  return (
    <List
      isLoading={isLoading || isPreparingFiles}
      navigationTitle={navigationTitle}
      searchBarAccessory={null}
      onSelectionChange={handleSelectionChange}
      actions={
        <ActionPanel>
          <Action title="New Search" icon={Icon.MagnifyingGlass} onAction={onNewSearch} />
        </ActionPanel>
      }
    >
      {!isLoading && samples.length === 0 ? (
        <List.EmptyView
          title="No samples found"
          description="No samples found matching your criteria. Try adjusting your search parameters."
          actions={
            <ActionPanel>
              <Action title="Try Different Search" onAction={onNewSearch} />
            </ActionPanel>
          }
        />
      ) : (
        samples.map((sample) => (
          <SampleItem key={sample.id} sample={sample} filePath={filePaths[sample.id] || null} />
        ))
      )}
    </List>
  );
}

export default function Command() {
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);

  // Cleanup playback on unmount
  useEffect(() => {
    return () => {
      cleanupPlayback();
    };
  }, []);

  const [isLoading, setIsLoading] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([]);

  // Fetch available genres using useCachedPromise (caches across command runs)
  const { data: genresData, isLoading: isLoadingGenres } = useCachedPromise(
    () => getAvailableGenres(),
    [],
    {
      initialData: { genres: {}, total_count: 0 },
    },
  );

  const availableGenres = genresData?.genres || {};

  const { handleSubmit, itemProps } = useForm<Values>({
    onSubmit: async (values) => {
      const { genres } = values;

      setIsLoading(true);
      setHasSearched(true);
      setSelectedGenres(genres || []);

      try {
        const searchParams = { genres: genres || [] };
        const response = await searchSamples(searchParams);
        setSamples(response.samples);
      } catch (error) {
        const errorMessage =
          error instanceof SoundrawAPIError ? error.message : "Failed to search samples. Please try again.";

        await showToast({
          title: "Search Failed",
          message: errorMessage,
          style: Toast.Style.Failure,
        });
        setSamples([]);
      } finally {
        setIsLoading(false);
      }
    },
    validation: {
      genres: (value) => {
        if (!value || value.length === 0) {
          return "Please select at least one genre";
        }
      },
    },
  });

  const handleNewSearch = () => {
    setHasSearched(false);
    setSamples([]);
    setSelectedGenres([]);
  };

  if (hasSearched) {
    return (
      <SamplesList
        samples={samples}
        isLoading={isLoading}
        onNewSearch={handleNewSearch}
        selectedGenres={selectedGenres}
        availableGenres={availableGenres}
      />
    );
  }

  return (
    <Form
      isLoading={isLoading || isLoadingGenres}
      actions={
        <ActionPanel>
          <Action.SubmitForm onSubmit={handleSubmit} title="Search Samples" icon={Icon.MagnifyingGlass} />
        </ActionPanel>
      }
    >
      <Form.TagPicker
        title="Genres"
        placeholder="Select genres to search"
        info="Choose one or more genres to find matching samples"
        {...itemProps.genres}
      >
        {Object.entries(availableGenres).map(([key, value]) => (
          <Form.TagPicker.Item key={key} title={value} value={key} />
        ))}
      </Form.TagPicker>

      {isLoadingGenres && <Form.Description text="Loading available genres..." />}

      {!isLoadingGenres && Object.keys(availableGenres).length === 0 && (
        <Form.Description text="No genres available. Please check your API connection." />
      )}
    </Form>
  );
}
