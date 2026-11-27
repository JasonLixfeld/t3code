package expo.modules.t3reviewdiff

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import org.json.JSONArray
import org.json.JSONObject

internal data class SearchMatch(
  val rowId: String,
  val start: Int,
  val end: Int
)

internal data class SearchHighlights(
  val ranges: Map<String, List<DiffWordDiffRange>> = emptyMap(),
  val active: SearchMatch? = null,
  val dark: Boolean = false
)

internal data class SearchReveal(
  val contentTop: Int,
  val contentBottom: Int,
  val targetHorizontalOffset: Int
)

internal fun searchMatchColor(dark: Boolean): Int =
  if (dark) Color.argb(0x66, 0xff, 0x96, 0x32) else Color.argb(0x88, 0xff, 0x96, 0x32)

internal fun activeSearchMatchColor(dark: Boolean): Int =
  if (dark) Color.argb(115, 0x69, 0xb1, 0xff) else Color.argb(115, 0x00, 0x9f, 0xff)

private fun parseSearchRanges(pairs: JSONArray): List<DiffWordDiffRange> =
  (0 until pairs.length()).mapNotNull { index ->
    val pair = pairs.optJSONArray(index)
    val start = pair?.optInt(0, -1) ?: -1
    val end = pair?.optInt(1, -1) ?: -1
    if (start >= 0 && end > start) DiffWordDiffRange(start, end) else null
  }

internal fun parseSearchHighlights(value: String, dark: Boolean): SearchHighlights = try {
  val payload = JSONObject(value)
  val rangesJson = payload.optJSONObject("ranges") ?: JSONObject()
  val ranges = rangesJson.keys().asSequence().associateWith { rowId ->
    rangesJson.optJSONArray(rowId)?.let(::parseSearchRanges).orEmpty()
  }
  val active = payload.optJSONObject("active")?.let {
    val start = it.optInt("start", -1)
    val end = it.optInt("end", -1)
    if (start >= 0 && end > start) SearchMatch(it.optString("rowId"), start, end) else null
  }
  SearchHighlights(ranges, active, dark)
} catch (_: Exception) {
  SearchHighlights(dark = dark)
}

internal class ReviewDiffSearchPainter(private val drawing: ReviewDiffCanvasDrawing) {
  var highlights = SearchHighlights()
  var tokensByRowId: Map<String, List<DiffToken>> = emptyMap()
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val selectionPath = Path()

  @Suppress("LongParameterList")
  fun draw(
    canvas: Canvas,
    row: DiffRow,
    tokens: List<DiffToken>?,
    codeX: Float,
    top: Int,
    bottom: Int,
    baseline: Float,
    lines: CodeLines,
    style: DiffStyle
  ) {
    val search = highlights
    val active = search.active
      ?.takeIf { it.rowId == row.id }
      ?.let { DiffWordDiffRange(it.start, it.end) }
    val ranges = search.ranges[row.id].orEmpty().filter { it != active }
    val layers = listOf(
      ranges to searchMatchColor(search.dark),
      listOfNotNull(active) to activeSearchMatchColor(search.dark),
    )
    for ((layer, color) in layers.filter { it.first.isNotEmpty() }) {
      val nativeLayout = lines.nativeLayout
      if (nativeLayout == null) {
        drawing.fillRanges(canvas, row, tokens, codeX, top, bottom, lines, style, layer, color)
        continue
      }
      paint.color = color
      canvas.save()
      canvas.translate(codeX, baseline - nativeLayout.getLineBaseline(0))
      val length = nativeLayout.text.length
      for (range in layer) {
        selectionPath.reset()
        nativeLayout.getSelectionPath(
          range.start.coerceIn(0, length),
          range.end.coerceIn(0, length),
          selectionPath,
        )
        canvas.drawPath(selectionPath, paint)
      }
      canvas.restore()
    }
  }

  @Suppress("LongParameterList")
  fun findLaidOutMatch(
    match: SearchMatch,
    rows: List<DiffRow>,
    rowOffsets: IntArray,
    wrap: CodeWrapLayout,
    style: DiffStyle,
    width: Int,
    offset: Int
  ): SearchReveal? {
    val index = rows.indexOfFirst { it.id == match.rowId }.takeIf { it >= 0 } ?: return null
    val row = rows[index]
    val lines = wrap.lines(row)
    val line = lines.lineForOffset(match.start)
    val top = rowOffsets[index] + lines.lineTopInRow(line)
    val height = if (line == 0) lines.firstHeight(style.rowHeightPx.toInt()) else lines.height
    val left = codeOffsetX(row, lines, match.start, style).toInt()
    val right = codeOffsetX(row, lines, match.end, style).toInt()
    val codeWidth =
      width - (style.changeBarWidthPx + style.gutterWidthPx + style.codePaddingPx * 2f).toInt()
    val inView = wrap.enabled || (left >= offset && right <= offset + codeWidth)
    return SearchReveal(top, top + height, if (inView) offset else left - codeWidth / 3)
  }

  private fun codeOffsetX(row: DiffRow, lines: CodeLines, offset: Int, style: DiffStyle): Float {
    lines.nativeLayout?.let { return it.getPrimaryHorizontal(offset.coerceIn(0, it.text.length)) }
    return drawing.paintedCodeOffsetX(row, tokensByRowId[row.id], lines, offset, style)
  }
}
