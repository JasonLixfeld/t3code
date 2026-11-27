package expo.modules.t3reviewdiff

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Looper
import android.view.MotionEvent
import android.view.View
import expo.modules.kotlin.AppContext
import java.time.Duration
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReviewDiffSearchTest {
  @Test
  fun highlightsPaintTheWebColorsWithoutNewGeometryAndClearOnEmpty() {
    withView { view, canvas, _ ->
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
      view.setSearchHighlightsJson(highlights(active = MATCH_ROW))
      assertTrue(
        "dark uses the web's dark current-match color",
        has(draw(canvas), over(Color.argb(115, 0x69, 0xb1, 0xff), dark))
      )

      view.setAppearanceScheme("light")
      view.setSearchHighlightsJson("")
      assertTrue("an empty payload clears highlights", draw(canvas).sameAs(plain))
    }
  }

  @Test
  fun aMatchJumpWaitsForItsFoldAndRevealsTheMatchBelowTheStickyHeader() {
    withView { view, canvas, _ ->
      view.setCollapsedFileIdsJson("[\"b.ts\"]")
      view.scrollToMatch(TARGET_ROW, 300, 306, false)
      assertEquals("a match in a folded file waits for the fold to open", 0, verticalOffset(canvas))

      view.setCollapsedFileIdsJson("[]")
      val offset = verticalOffset(canvas)
      val style = canvas.javaClass.getMethod("getStyle").invoke(canvas) as DiffStyle
      val top = rowTop(canvas, rowIndex(TARGET_ROW))
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

  @Test
  fun aNewJumpStopsInFlightScrollsEvenWhenItsMatchIsAlreadyVisible() {
    withView { view, _, _ ->
      val vertical = scroller(view, "verticalScroller")
      val horizontal = scroller(view, "horizontalScroller")
      vertical.fling(0, 100, 0, 2000, 0, 0, 0, 10000)
      horizontal.fling(0, 0, 2000, 0, 0, 10000, 0, 0)

      view.scrollToMatch(MATCH_ROW, 0, 5, false)

      assertTrue("the vertical animation stops", vertical.isFinished)
      assertTrue("the horizontal fling stops", horizontal.isFinished)
    }
  }

  @Test
  fun anAnimatedJumpReportsOnlyTheFileItLandsIn() {
    val files = (0 until 5).map { "f$it.ts" }
    withView(files) { view, _, appContext ->
      appContext.events.clear()

      view.scrollToMatch("f4.ts:line:10", 0, 5, true)
      repeat(60) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(16))
        view.computeScroll()
      }

      val visibleFiles = appContext.events
        .filter { it.first == "onVisibleFileChange" }
        .map { it.second["fileId"] }
      assertEquals(listOf("f4.ts"), visibleFiles)
    }
  }

  @Test
  fun aTouchThatStopsAnAnimatedJumpReportsTheFileWhereItStopped() {
    val files = (0 until 5).map { "f$it.ts" }
    withView(files) { view, canvas, appContext ->
      view.scrollToMatch("f4.ts:line:10", 0, 5, true)
      repeat(4) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(16))
        view.computeScroll()
      }
      appContext.events.clear()

      val down = MotionEvent.obtain(0, 0, MotionEvent.ACTION_DOWN, 10f, 10f, 0)
      view.onInterceptTouchEvent(down)
      down.recycle()

      val visibleFiles = appContext.events.filter { it.first == "onVisibleFileChange" }
      val offset = canvas.javaClass.getDeclaredMethod("verticalOffset").invoke(canvas) as Int
      assertTrue(
        "the jump was stopped part of the way",
        offset < rowTop(canvas, rowIndex("f4.ts:line:10", files))
      )
      assertEquals(1, visibleFiles.size)
      assertTrue(visibleFiles.single().second["fileId"] != "f4.ts")
    }
  }

  @Test
  fun aContentResetEndsTheDeferredVisibleFileEvent() {
    withView { view, _, _ ->
      view.scrollToMatch(TARGET_ROW, 300, 306, true)
      view.setContentResetKey("next-content")

      val deferred = view.javaClass.getDeclaredField("deferVisibleFileEventUntilScrollEnds")
        .apply { isAccessible = true }.getBoolean(view)
      assertTrue("a reset must not keep hiding the next content's visible file", !deferred)
    }
  }

  private fun scroller(view: T3ReviewDiffView, name: String) =
    view.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(view)
      as android.widget.OverScroller

  private fun withView(
    files: List<String> = listOf("a.ts", "b.ts"),
    block: (T3ReviewDiffView, View, AppContext) -> Unit
  ) {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val appContext = AppContext()
    val view = T3ReviewDiffView(activity, appContext)
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
      view.setRowsJson(rows(files))
      decoder.completeNext()
      block(view, canvas, appContext)
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

  private fun rows(files: List<String> = listOf("a.ts", "b.ts")): String = JSONArray(
    files.flatMap { file ->
      listOf(JSONObject().put("kind", "file").put("id", "$file:header").put("fileId", file)) +
        (0 until 100).map { line -> codeRow(file, line) }
    },
  ).toString()

  private fun rowIndex(id: String, files: List<String> = listOf("a.ts", "b.ts")): Int {
    val rows = JSONArray(rows(files))
    return (0 until rows.length()).indexOfFirst { rows.getJSONObject(it).getString("id") == id }
  }

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
  }
}
