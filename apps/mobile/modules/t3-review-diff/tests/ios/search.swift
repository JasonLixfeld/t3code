// Search highlights paint without new geometry; a match jump waits for its fold to open.
private extension T3ReviewDiffView {
  func checkSearch() throws {
    frame = CGRect(x: 0, y: 0, width: 390, height: 600)
    layoutSubviews()
    setContentInsetTop(80)
    let longLine = String(repeating: "x", count: 300) + "needle"
    var fixture: [[String: String]] = []
    for file in ["a.ts", "b.ts"] {
      fixture.append(["kind": "file", "id": "\(file):header", "fileId": file])
      for line in 0..<100 {
        let content = line == 80 ? longLine : "plain code \(line)"
        fixture.append(["kind": "line", "id": "\(file):line:\(line)", "fileId": file, "change": "add", "content": content])
      }
    }
    rows = try JSONDecoder().decode([ReviewDiffNativeRow].self, from: JSONSerialization.data(withJSONObject: fixture))
    contentView.rows = rows
    setCollapsedFileIdsJson("[\"b.ts\"]")
    updateContentMetrics()

    let target = "b.ts:line:80"
    let height = contentView.contentHeight
    let ranges = "\"ranges\":{\"\(target)\":[[300,306]],\"a.ts:line:1\":[[0,5]]}"
    let active = "\"active\":{\"rowId\":\"\(target)\",\"start\":300,\"end\":306}"
    setSearchHighlightsJson("{" + ranges + "," + active + "}")
    check(contentView.contentHeight == height, "Search highlights must not change geometry")
    check(contentView.searchHighlights(rowId: "a.ts:line:1") == ["match"], "A match paints the match color")
    check(contentView.searchHighlights(rowId: target) == ["active"],
          "The current match replaces its match color")

    // #ff963288 and #009fff at 45% on light, #ff963266 and #69b1ff at 45% on dark.
    let lightColors: [Int] = [255, 150, 50, 136, 0, 159, 255, 115]
    let darkColors: [Int] = [255, 150, 50, 102, 105, 177, 255, 115]
    check(contentView.searchColorBytes == lightColors, "Light uses the web diff's find colors")
    setAppearanceScheme("dark")
    check(contentView.searchColorBytes == darkColors, "Dark uses the web diff's find colors")
    check(contentView.searchHighlights(rowId: target) == ["active"], "Dark keeps the current match")

    let before = scrollView.contentOffset.y
    scrollToMatch(target, start: 300, end: 306, animated: false)
    check(scrollView.contentOffset.y == before, "A match in a folded file waits for the fold to open")
    setCollapsedFileIdsJson("[]")
    let index = rows.firstIndex { $0.id == target }!
    let rowFrame = contentView.frameForRow(at: index)!
    let visibleTop = scrollView.contentOffset.y + scrollView.contentInset.top + contentView.style.fileHeaderHeight
    let visibleBottom = scrollView.contentOffset.y + bounds.height - scrollView.contentInset.bottom
    check(rowFrame.minY >= visibleTop && rowFrame.maxY <= visibleBottom,
          "The match row shows below the sticky header once its fold opens")
    let offset = contentView.horizontalCodeOffset(fileId: "b.ts")
    let matchX = 300 * contentView.characterWidth
    check(offset > 0 && matchX >= offset && matchX < offset + bounds.width,
          "A match past the right edge scrolls its file horizontally into view")

    setSearchHighlightsJson("")
    check(contentView.searchHighlights(rowId: target).isEmpty, "An empty payload clears highlights")
    print("Passed search highlights, fold-aware match jump, and horizontal reveal")
  }
}

private extension ReviewDiffContentView {
  func searchHighlights(rowId: String) -> [String] {
    let row = rows.first { $0.id == rowId }!
    return codeHighlights(for: row).compactMap { highlight in
      if highlight.color == searchMatchColor { return "match" }
      if highlight.color == activeSearchMatchColor { return "active" }
      return nil
    }
  }

  /// Match then current-match RGBA as bytes.
  var searchColorBytes: [Int] {
    var bytes: [Int] = []
    for color in [searchMatchColor, activeSearchMatchColor] {
      var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
      color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
      for channel in [red, green, blue, alpha] {
        bytes.append(Int((channel * 255).rounded()))
      }
    }
    return bytes
  }

  func horizontalCodeOffset(fileId: String) -> CGFloat { horizontalOffset(for: fileId) }

  var characterWidth: CGFloat { codeCharacterWidth }
}
try T3ReviewDiffView().checkSearch()
