// ==UserScript==
// @name         Tokybook Helper
// @version      0.0.1
// @description  Adds download buttons to audio book chapters from Tokybook
// @author       SoSeDiK
// @license      MIT
// @namespace    https://github.com/SoSeDiK/Scripties
// @website      https://github.com/SoSeDiK/Scripties/tampermonkey/tokybook-helper.js
// @match        https://tokybook.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.9.1/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js
// @require      https://github.com/PRO-2684/GM_config/releases/download/v1.2.1/config.min.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const MEDIA_URL = "https://files01.tokybook.com/audio/";
  const MEDIA_FALLBACK_URL = "https://files02.tokybook.com/audio/";

  const configDesc = {
    shrink_cover: {
      name: "Shrink the book cover image",
      type: "bool",
      value: true,
    },
    move_player: {
      name: "Move the player to the top",
      type: "bool",
      value: true,
    },
    download_cover: {
      name: "Include the book cover image in the zip file",
      type: "bool",
      value: true,
    },
  };
  const config = new GM_config(configDesc);

  let downloadInProgress = false;

  async function explorePage() {
    const bookTitle = await extractBookTitle();
    if (!bookTitle) return console.log("No book title found on this page.");

    const bookChapters = await extractBookChapters();
    if (!bookChapters) return logError("Could not extract book chapters.");

    await addChapterDownloads(bookTitle, bookChapters);
  }

  async function shrinkCover() {
    const style = document.createElement("style");
    style.textContent = `
            .page-hero {
                padding-top: 5% !important;
            }
        `;
    document.head.appendChild(style);
  }

  async function movePlayerUp() {
    const mainElement = document.getElementById("main");
    const fullContainDiv = document.querySelector(".playlistt .full-contain");
    if (fullContainDiv && mainElement) {
      mainElement.insertBefore(fullContainDiv, mainElement.firstChild);
    } else {
      console.warn("Could not move the audio player up.");
    }
  }

  async function extractBookTitle() {
    const bookTitleElement = document.querySelector(
      "div.inside-page-hero.grid-container.grid-parent h1"
    );
    return bookTitleElement ? bookTitleElement.textContent.trim() : null;
  }

  async function extractBookChapters() {
    let jsonString = null;
    const scripts = document.getElementsByTagName("script");
    for (let script of scripts) {
      const match = script.text.match(/tracks\s*=\s*(\[[^\]]+\])\s*/);
      if (match) {
        jsonString = match[1];
        break;
      }
    }

    if (!jsonString) return null;

    // For some reason welcome entry is malformed
    jsonString = jsonString.replace(/,\s*}/, "}");
    const tracks = JSON.parse(jsonString);
    const map = tracks.reduce(
      (map, track) =>
        map.set(track.track, {
          name: track.name,
          url: encodeURIComponent(track.chapter_link_dropbox),
        }),
      new Map()
    );
    map.delete(1);
    return map;
  }

  async function extractCover() {
    const pageHeroDiv = document.querySelector(".page-hero");
    if (!pageHeroDiv) return null;

    const style = window.getComputedStyle(pageHeroDiv);
    const backgroundImage = style.backgroundImage;
    const urlMatch = backgroundImage.match(/url\("(.*)"\)$/);

    return urlMatch ? urlMatch[1] : null;
  }

  async function addChapterDownloads(bookTitle, bookChapters) {
    const ulElement = document.getElementById("plList");
    if (!ulElement) return logError("Could not find book chapters.");

    const liElements = ulElement.getElementsByTagName("li");
    for (let i = 0; i < liElements.length; i++) {
      const liElement = liElements[i];
      const plItem = liElement.querySelector(".plTitle");
      if (!plItem) continue;

      const downloadAll = i === 0;

      const chapter = bookChapters.get(i + 1);
      if (!downloadAll && !chapter) continue;

      const button = document.createElement("button");
      button.innerHTML = downloadAll ? "⏬" : "🔽";
      button.style.cssText =
        "background: transparent; margin: 0; margin-right: 10px; padding: 0; border: none;";

      button.addEventListener("click", async (event) => {
        event.stopPropagation();

        if (downloadAll) {
          await downloadAsZip(bookTitle, bookChapters);
        } else {
          await downloadChapter(chapter);
        }
      });

      plItem.prepend(button);
    }
  }

  async function downloadChapter(chapter) {
    let blob = await fetchMediaBlob(chapter.url);
    if (!blob) return logError("Could not download chapter.");

    saveAs(blob, `${chapter.name}.${getExtension(chapter.url)}`);
  }

  async function downloadAsZip(bookTitle, bookChapters) {
    console.log("T: " + downloadInProgress);
    if (downloadInProgress) return;

    const plwrap = document.getElementById("audiowrap");
    if (!plwrap)
      return logError(
        "Element #audiowrap not found, report this to the script author."
      );

    downloadInProgress = true;

    let currentChapter = 0;
    const totalMedia = bookChapters.size;

    const statusDiv = document.createElement("div");
    statusDiv.id = "zipStatus";
    const statusState = document.createElement("p");
    statusState.style.marginBottom = "5px";
    const progressElement = document.createElement("progress");
    progressElement.value = 0;
    progressElement.max = 100;
    progressElement.style.width = "100%";

    statusDiv.appendChild(statusState);
    statusDiv.appendChild(progressElement);
    plwrap.appendChild(statusDiv);

    try {
      const zip = new JSZip();

      if (config.get("download_cover")) {
        statusState.textContent = "Fetching the cover image";
        const coverImageUrl = await extractCover();
        if (coverImageUrl) {
          try {
            const blob = await fetchBlob(coverImageUrl);
            if (blob) zip.file(`cover.${getExtension(coverImageUrl)}`, blob);
          } catch (error) {
            logError("Could not add zip entry:" + error.message);
            return;
          }
          console.log("Zipped the cover image");
        } else {
          console.warn("Could not find the cover image");
        }
      }

      for (let [_, chapter] of bookChapters) {
        currentChapter++;
        statusState.textContent = `Fetching chapters: ${currentChapter}/${totalMedia}`;
        progressElement.value = (currentChapter / totalMedia) * 100;
        try {
          const blob = await fetchMediaBlob(chapter.url);
          if (blob)
            zip.file(`${chapter.name}.${getExtension(chapter.url)}`, blob);
        } catch (error) {
          logError(
            `Could not add zip entry for "${chapter.name}":` + error.message
          );
          return;
        }
      }

      progressElement.value = 0;
      statusState.textContent = "Creating archive: 0%";

      console.log("Generating archive");
      const content = await zip.generateAsync(
        {
          type: "blob",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        },
        (metadata) => {
          progressElement.value = metadata.percent;
          statusState.textContent = `Creating archive: ${metadata.percent.toFixed(
            2
          )}%`;
        }
      );
      console.log(`Archive "${bookTitle}.zip" is ready`);
      saveAs(content, `${bookTitle}.zip`);
    } catch (error) {
      logError("Could not save zip archive:" + error.message);
    } finally {
      statusDiv.remove();
      downloadInProgress = false;
    }
  }

  async function fetchMediaBlob(url) {
    let blob = await fetchBlob(`${MEDIA_URL}${url}`);
    if (!blob) blob = await fetchBlob(`${MEDIA_FALLBACK_URL}${url}`);
    return blob;
  }

  async function fetchBlob(url) {
    const response = await fetch(url);
    return response.ok ? await response.blob() : null;
  }

  function getExtension(url) {
    const parts = url.split(".");
    return parts[parts.length - 1];
  }

  function logError(message) {
    console.error(message);
    alert(message);
  }

  if (config.get("shrink_cover")) shrinkCover();
  if (config.get("move_player"))
    window.addEventListener("DOMContentLoaded", movePlayerUp);
  window.addEventListener("load", explorePage);
})();
