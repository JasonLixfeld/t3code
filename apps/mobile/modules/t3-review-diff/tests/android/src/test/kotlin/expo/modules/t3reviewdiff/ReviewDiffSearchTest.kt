package expo.modules.t3reviewdiff

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Looper
import android.view.View
import expo.modules.kotlin.AppContext
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

// Search highlights paint the web diff's find colors without new geometry; a match jump waits
// for its fold to open.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReviewDiffSearchTest {
  @Test
  fun highlightsPaintTheWebColorsWithoutNewGeometryAndClearOnEmpty() {
    withView { view, canvas ->
      val plain = draw(canvas)
      val offsets = field(canvas, "rowOffsets")
      view.setSearchHighlightsJson(highlights(active = null))
      assertSame(
        "search highlights must not rebuild row geometry",
        offsets,
        field(canvas, "rowOffsets")
      )
      val light = DiffTheme.fallback("light").background
      assertTrue(
        "a match paints the web's light match color",
        has(draw(canvas), over(Color.argb(0x88, 0xff, 0x96, 0x32), light))
      )

      view.setSearchHighlightsJson(highlights(active = MATCH_ROW))
      assertTrue(
        "the active match paints the web's current-match color",
        has(draw(canvas), over(Color.argb(115, 0x00, 0x9f, 0xff), light)),
      )

      view.setAppearanceScheme("dark")
      view.setSearchHighlightsJson(highlights(active = null))
      val dark = DiffTheme.fallback("dark").background
      assertTrue(
        "dark uses the web's dark match color",
        has(draw(canvas), over(Color.argb(0x66, 0xff, 0x96, 0x32), dark))
      )

      view.setAppearanceScheme("light")
      view.setSearchHighlightsJson("")
      assertTrue("an empty payload clears highlights", draw(canvas).sameAs(plain))
    }
  }

  @Test
  fun aMatchJumpWaitsForItsFoldAndRevealsTheMatchBelowTheStickyHeader() {
    withView { view, canvas ->
      view.setCollapsedFileIdsJson("[\"b.ts\"]")
      view.scrollToMatch(TARGET_ROW, 300, 306, false)
      assertEquals("a match in a folded file waits for the fold to open", 0, verticalOffset(canvas))

      view.setCollapsedFileIdsJson("[]")
      val offset = verticalOffset(canvas)
      val style = canvas.javaClass.getMethod("getStyle").invoke(canvas) as DiffStyle
      val top = rowTop(canvas, TARGET_INDEX)
      assertTrue(
        "the match row shows below the sticky header once its fold opens",
        top >= offset + style.fileHeaderHeightPx &&
          top + style.rowHeightPx <= offset + canvas.height,
      )
      val horizontal = canvas.javaClass.getDeclaredMethod("horizontalOffset").invoke(canvas) as Int
      val paint = Paint().apply {
        typeface = Typeface.create("monospace", Typeface.NORMAL)
        textSize = style.codeFontSizePx
      }
      val matchX = paint.measureText("x".repeat(300))
      assertTrue(
        "a match past the right edge scrolls the code horizontally into view",
        horizontal > 0 && matchX >= horizontal && matchX < horizontal + canvas.width,
      )
    }
  }

  private fun withView(block: (T3ReviewDiffView, View) -> Unit) {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val view = T3ReviewDiffView(activity, AppContext())
    val decoder = ManualDecoder()
    view.javaClass.getDeclaredField("payloadDecodeExecutor").apply { isAccessible = true }
      .set(view, decoder)
    activity.setContentView(view)
    val canvas = view.getChildAt(0)
    val measure = View.MeasureSpec.makeMeasureSpec(320, View.MeasureSpec.EXACTLY)
    canvas.measure(measure, measure)
    canvas.layout(0, 0, 320, 320)
    try {
      view.setAppearanceScheme("light")
      view.setRowsJson(rows())
      decoder.completeNext()
      block(view, canvas)
    } finally {
      view.cleanup()
      activity.finish()
    }
  }

  private fun highlights(active: String?): String = JSONObject().apply {
    put("ranges", JSONObject().put(MATCH_ROW, JSONArray().put(JSONArray().put(0).put(5))))
    if (active !=
      null
    ) {
      put("active", JSONObject().put("rowId", active).put("start", 0).put("end", 5))
    }
  }.toString()

  private fun rows(): String = JSONArray(
    listOf("a.ts", "b.ts").flatMap { file ->
      listOf(JSONObject().put("kind", "file").put("id", "$file:header").put("fileId", file)) +
        (0 until 100).map { line -> codeRow(file, line) }
    },
  ).toString()

  private fun codeRow(file: String, line: Int): JSONObject {
    val content = if (line == 80) "x".repeat(300) + "needle" else "plain code $line"
    return JSONObject().put("kind", "line").put("id", "$file:line:$line").put("fileId", file)
      .put("change", "context").put("content", content)
  }

  private fun draw(canvas: View): Bitmap =
    Bitmap.createBitmap(320, 320, Bitmap.Config.ARGB_8888).also { canvas.draw(Canvas(it)) }

  private fun over(color: Int, background: Int): Int {
    val alpha = Color.alpha(color) / 255f
    fun channel(top: Int, bottom: Int) = (top * alpha + bottom * (1 - alpha)).toInt()
    return Color.rgb(
      channel(Color.red(color), Color.red(background)),
      channel(Color.green(color), Color.green(background)),
      channel(Color.blue(color), Color.blue(background)),
    )
  }

  private fun has(bitmap: Bitmap, color: Int): Boolean {
    for (y in 0 until bitmap.height) {
      for (x in 0 until bitmap.width) {
        val pixel = bitmap.getPixel(x, y)
        if (abs(Color.red(pixel) - Color.red(color)) <= 2 &&
          abs(Color.green(pixel) - Color.green(color)) <= 2 &&
          abs(Color.blue(pixel) - Color.blue(color)) <= 2
        ) {
          return true
        }
      }
    }
    return false
  }

  private fun field(target: Any, name: String): Any =
    target.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(target)

  private fun verticalOffset(canvas: View): Int =
    canvas.javaClass.getDeclaredMethod("verticalOffset").invoke(canvas) as Int

  private fun rowTop(canvas: View, index: Int): Int = canvas.javaClass
    .getDeclaredMethod("rowTop", Int::class.javaPrimitiveType).apply { isAccessible = true }
    .invoke(canvas, index) as Int

  private class ManualDecoder : AbstractExecutorService() {
    private val work = ArrayDeque<Runnable>()
    override fun execute(command: Runnable) {
      work.addLast(command)
    }
    fun completeNext() {
      work.removeFirst().run()
      shadowOf(Looper.getMainLooper()).idle()
    }
    override fun shutdown() = Unit
    override fun shutdownNow(): MutableList<Runnable> = mutableListOf()
    override fun isShutdown() = false
    override fun isTerminated() = false
    override fun awaitTermination(timeout: Long, unit: TimeUnit) = true
  }

  private companion object {
    const val MATCH_ROW = "a.ts:line:1"
    const val TARGET_ROW = "b.ts:line:80"

    // a.ts header and 100 lines, b.ts header, then line 80.
    const val TARGET_INDEX = 182
  }
}
