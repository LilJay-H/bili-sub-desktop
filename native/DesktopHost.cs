// Windows 自带 WPF 提供真正的逐像素透明窗口；浏览器只传字幕和播放命令。
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using System.Runtime.InteropServices;

internal static class Program {
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576, RecursionLimit = 16 };
    static readonly object OutputLock = new object();
    static Stream output;
    internal static bool Testing, ProtocolTesting;
    internal static object LastTestMessage;
    [STAThread] static int Main(string[] args) {
        Testing = args.Length > 0 && args[0] == "--self-test";
        ProtocolTesting = args.Length > 0 && args[0] == "--protocol-test";
        try {
            output = Console.OpenStandardOutput();
            Application app = new Application();
            SubtitleWindow window = new SubtitleWindow();
            app.MainWindow = window;
            if (Testing || ProtocolTesting) { window.Left = -20000; window.Top = -20000; }
            if (Testing) {
                string dir = args.Length > 1 ? Path.GetFullPath(args[1]) : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "test-output");
                window.Left = -20000; window.Top = -20000;
                window.Loaded += delegate { window.Dispatcher.BeginInvoke(new Action(delegate {
                    try { window.SelfTest(dir); app.Shutdown(0); }
                    catch (Exception ex) { File.WriteAllText(Path.Combine(dir,"native-test-error.txt"), ex.GetType().Name + ": " + ex.Message); app.Shutdown(1); }
                }), DispatcherPriority.ApplicationIdle); };
            } else {
                Thread reader = new Thread(delegate() { ReadMessages(window); }); reader.IsBackground = true; reader.Start();
                window.Loaded += delegate { Send(new { type = "ready" }); };
            }
            return app.Run(window);
        } catch { return 1; }
    }
    static bool ReadExactly(Stream input, byte[] bytes) {
        int offset=0; while(offset<bytes.Length) { int n=input.Read(bytes,offset,bytes.Length-offset); if(n==0)return false;offset+=n; } return true;
    }
    static void ReadMessages(SubtitleWindow window) {
        try {
            Stream input=Console.OpenStandardInput(); byte[] header=new byte[4];
            while(ReadExactly(input,header)) {
                uint length=BitConverter.ToUInt32(header,0); if(length<2 || length>1048576)break;
                byte[] body=new byte[length]; if(!ReadExactly(input,body))break;
                Dictionary<string,object> data;
                lock(Json) { data=Json.DeserializeObject(Encoding.UTF8.GetString(body)) as Dictionary<string,object>; }
                if(data==null)continue;
                window.Dispatcher.BeginInvoke(new Action(delegate { window.Apply(data); }));
            }
        } catch { /* 断开即关闭，不打印协议内容。 */ }
        try { window.Dispatcher.BeginInvoke(new Action(delegate { window.Close(); })); } catch {}
    }
    internal static void Send(object message) {
        if(Testing){LastTestMessage=message;return;}
        try { lock(OutputLock) { string text; lock(Json) {text=Json.Serialize(message);} byte[] bytes=Encoding.UTF8.GetBytes(text); byte[] head=BitConverter.GetBytes(bytes.Length); output.Write(head,0,4);output.Write(bytes,0,bytes.Length);output.Flush(); } } catch {}
    }
}

internal sealed class CaptionBackdrop : FrameworkElement {
    internal Func<Geometry> Shape;
    internal Brush Fill;
    protected override void OnRender(DrawingContext drawing){base.OnRender(drawing);if(Shape!=null&&Fill!=null){Geometry geometry=Shape();if(geometry!=null)drawing.DrawGeometry(Fill,null,geometry);}}
}

internal sealed class SubtitleWindow : Window {
    readonly Grid canvas = new Grid();
    readonly ScrollViewer scroll = new ScrollViewer();
    readonly TextBlock text = new TextBlock();
    readonly CaptionBackdrop captionBackdrop = new CaptionBackdrop {IsHitTestVisible=false};
    readonly Border top = new Border(), bottom = new Border(), settings = new Border(), ratePanel = new Border();
    readonly TextBlock clock = new TextBlock(), status = new TextBlock();
    readonly List<Hyperlink> lines = new List<Hyperlink>();
    readonly List<double> starts = new List<double>();
    readonly List<int> offsets = new List<int>(), lengths = new List<int>();
    string fullText="";
    FormattedText cachedLayout;
    string cachedText;
    double cachedWidth, cachedFont;
    Geometry plateGeometry;
    string plateText;
    double plateWidth,plateFont;
    readonly List<Thumb> grips = new List<Thumb>();
    readonly Button play = new Button(), follow = new Button(), rateButton = new Button();
    readonly Button flowButton = new Button(), linesButton = new Button(), lightButton = new Button(), darkButton = new Button();
    readonly List<Button> rateButtons = new List<Button>();
    readonly Grid settingsGrid = new Grid();
    readonly UniformGrid rateGrid = new UniformGrid();
    readonly ScrollViewer settingsScroll = new ScrollViewer();
    readonly List<FrameworkElement> settingsFields = new List<FrameworkElement>();
    readonly List<Dictionary<string,object>> cueData = new List<Dictionary<string,object>>();
    Button backward, forward;
    readonly Slider alpha = new Slider(), font = new Slider(), captionAlpha = new Slider();
    readonly TextBlock alphaLabel = new TextBlock(), fontLabel = new TextBlock(), captionAlphaLabel = new TextBlock();
    readonly TextBlock diagnostics = new TextBlock {FontSize=10,TextWrapping=TextWrapping.Wrap};
    int active=-1;
    double seconds, step=10, transparency=100, captionOpacity=90, fontSize=18, currentRate=1;
    bool applying, following=true, showing, isClosed;
    string theme="paper", layout="flow", lastStatus="";
    readonly string preferencePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BiliSubDesktop", "window.json");
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd,int index);

    internal SubtitleWindow() {
        Title="B站透明字幕"; Width=760;Height=192;MinWidth=360;MinHeight=120;
        WindowStyle=WindowStyle.None;AllowsTransparency=true;Background=Brushes.Transparent;
        Topmost=true;ShowInTaskbar=false;ShowActivated=false;ResizeMode=ResizeMode.NoResize;
        FontFamily=new FontFamily("Microsoft YaHei UI");
        Rect work=SystemParameters.WorkArea;Left=work.Right-Width-30;Top=work.Bottom-Height-30;
        if(!Program.Testing && !Program.ProtocolTesting)LoadGeometry();
        Content=canvas;
        scroll.Margin=new Thickness(10,4,10,4);scroll.VerticalScrollBarVisibility=ScrollBarVisibility.Hidden;scroll.HorizontalScrollBarVisibility=ScrollBarVisibility.Disabled;
        text.TextWrapping=TextWrapping.Wrap;text.LineHeight=30;text.Padding=new Thickness(1,0,1,0);
        Grid textLayer=new Grid();textLayer.Children.Add(captionBackdrop);textLayer.Children.Add(text);scroll.Content=textLayer;canvas.Children.Add(scroll);
        captionBackdrop.Shape=PlateGeometry;text.SizeChanged+=delegate{captionBackdrop.InvalidateVisual();};
        scroll.PreviewMouseWheel += delegate {following=false;follow.Visibility=Visibility.Visible;};
        BuildControlStyle();BuildChrome();BuildGrips();ApplyAppearance();Reveal(false);
        canvas.MouseEnter += delegate {Reveal(true);};
        canvas.MouseLeave += delegate {if(!IsMouseOver && !grips.Exists(g=>g.IsDragging))Reveal(false);};
        SizeChanged += delegate { ArrangeSettings();if(following) Dispatcher.BeginInvoke(new Action(Center),DispatcherPriority.Loaded); };
        PreviewKeyDown += delegate(object sender,KeyEventArgs e) {
            if(e.Key==Key.Tab)Reveal(true);
            if(e.Key==Key.Escape){if(settings.Visibility==Visibility.Visible||ratePanel.Visibility==Visibility.Visible){ClosePanels();rateButton.Focus();}else Reveal(false);e.Handled=true;}
        };
        Closed += delegate {isClosed=true;if(!Program.Testing && !Program.ProtocolTesting)SaveGeometry();Program.Send(new {type="closed"});};
    }
    Button MakeButton(string label, Action action) {
        Button b=new Button {Content=label,Margin=new Thickness(2,0,2,0),Padding=new Thickness(7,3,7,3),MinHeight=28,FontSize=12,Cursor=Cursors.Hand};
        b.Click += delegate {action();};return b;
    }
    void BuildControlStyle() {
        Style style=new Style(typeof(Button));
        style.Setters.Add(new Setter(Control.ForegroundProperty,new DynamicResourceExtension("ControlInk")));
        style.Setters.Add(new Setter(Control.BackgroundProperty,new DynamicResourceExtension("ControlSurface")));
        style.Setters.Add(new Setter(Control.BorderBrushProperty,new DynamicResourceExtension("ControlBorder")));
        style.Setters.Add(new Setter(Control.BorderThicknessProperty,new Thickness(0)));
        style.Setters.Add(new Setter(Control.PaddingProperty,new Thickness(7,3,7,3)));
        style.Setters.Add(new Setter(Control.FontSizeProperty,12.0));
        style.Setters.Add(new Setter(FrameworkElement.MinHeightProperty,28.0));
        style.Setters.Add(new Setter(FrameworkElement.CursorProperty,Cursors.Hand));
        FrameworkElementFactory border=new FrameworkElementFactory(typeof(Border));border.Name="buttonFace";
        border.SetValue(Border.CornerRadiusProperty,new CornerRadius(2));
        border.SetValue(Border.BackgroundProperty,new TemplateBindingExtension(Control.BackgroundProperty));
        border.SetValue(Border.BorderBrushProperty,new TemplateBindingExtension(Control.BorderBrushProperty));
        border.SetValue(Border.BorderThicknessProperty,new TemplateBindingExtension(Control.BorderThicknessProperty));
        border.SetValue(Border.PaddingProperty,new TemplateBindingExtension(Control.PaddingProperty));
        FrameworkElementFactory label=new FrameworkElementFactory(typeof(ContentPresenter));
        label.SetValue(ContentPresenter.ContentProperty,new TemplateBindingExtension(ContentControl.ContentProperty));
        label.SetValue(FrameworkElement.HorizontalAlignmentProperty,HorizontalAlignment.Center);label.SetValue(FrameworkElement.VerticalAlignmentProperty,VerticalAlignment.Center);border.AppendChild(label);
        ControlTemplate template=new ControlTemplate(typeof(Button)){VisualTree=border};
        Trigger hover=new Trigger {Property=UIElement.IsMouseOverProperty,Value=true};hover.Setters.Add(new Setter(Border.BackgroundProperty,new DynamicResourceExtension("ControlHover"),"buttonFace"));template.Triggers.Add(hover);
        Trigger focus=new Trigger {Property=UIElement.IsKeyboardFocusedProperty,Value=true};focus.Setters.Add(new Setter(Border.BorderBrushProperty,new DynamicResourceExtension("Accent"),"buttonFace"));focus.Setters.Add(new Setter(Border.BorderThicknessProperty,new Thickness(1),"buttonFace"));template.Triggers.Add(focus);
        style.Setters.Add(new Setter(Control.TemplateProperty,template));Resources[typeof(Button)]=style;
    }
    void Command(string action, double value) {Program.Send(new {type="command",action=action,value=value});}
    void BuildChrome() {
        DockPanel header=new DockPanel {LastChildFill=true};
        Button close=MakeButton("↙ 页内",delegate{SaveGeometry();Command("close",0);Close();});close.ToolTip="回到页内字幕";DockPanel.SetDock(close,Dock.Right);header.Children.Add(close);
        clock.FontSize=11;clock.VerticalAlignment=VerticalAlignment.Center;clock.Margin=new Thickness(6,0,9,0);DockPanel.SetDock(clock,Dock.Right);header.Children.Add(clock);
        follow.Content="跟随播放";follow.FontSize=11;follow.Margin=new Thickness(3,0,3,0);follow.Click+=delegate{following=true;follow.Visibility=Visibility.Collapsed;Center();};follow.Visibility=Visibility.Collapsed;DockPanel.SetDock(follow,Dock.Right);header.Children.Add(follow);
        status.Text="字幕 · 拖动移动";status.FontSize=11;status.TextTrimming=TextTrimming.CharacterEllipsis;status.VerticalAlignment=VerticalAlignment.Center;
        Border handle=new Border {Child=status,Background=Brushes.Transparent,Cursor=Cursors.SizeAll,Padding=new Thickness(9,0,3,0),ToolTip="拖动此处移动，拖边框缩放"};
        handle.MouseLeftButtonDown+=delegate {try{DragMove();SaveGeometry();}catch{};};header.Children.Add(handle);
        top.Child=header;top.Height=30;top.VerticalAlignment=VerticalAlignment.Top;top.Margin=new Thickness(5,4,5,0);top.BorderThickness=new Thickness(0,0,0,1);canvas.Children.Add(top);
        WrapPanel controls=new WrapPanel {Orientation=Orientation.Horizontal,HorizontalAlignment=HorizontalAlignment.Center};
        Button previous=MakeButton("|‹",delegate{Command("prev",0);});previous.ToolTip="上一集 / 上一分P";previous.FontSize=17;controls.Children.Add(previous);
        backward=MakeButton("−10s",delegate{Command("seekBy",-step);});backward.ToolTip="快退";controls.Children.Add(backward);
        play.Content="▷";play.Padding=new Thickness(11,0,11,0);play.FontSize=18;play.ToolTip="播放 / 暂停";play.Click+=delegate{Command("toggle",0);};controls.Children.Add(play);
        forward=MakeButton("+10s",delegate{Command("seekBy",step);});forward.ToolTip="快进";controls.Children.Add(forward);
        Button next=MakeButton("›|",delegate{Command("next",0);});next.ToolTip="下一集 / 下一分P";next.FontSize=17;controls.Children.Add(next);
        rateButton.Content="1×";rateButton.MinWidth=44;rateButton.Margin=new Thickness(6,0,2,0);rateButton.ToolTip="播放速度";rateButton.Click+=delegate{OpenPanel(ratePanel);};controls.Children.Add(rateButton);
        controls.Children.Add(MakeButton("外观",delegate{OpenPanel(settings);}));
        bottom.Child=controls;bottom.HorizontalAlignment=HorizontalAlignment.Center;bottom.VerticalAlignment=VerticalAlignment.Bottom;bottom.Margin=new Thickness(5,0,5,4);bottom.Padding=new Thickness(5,3,5,3);bottom.BorderThickness=new Thickness(1);canvas.Children.Add(bottom);
        alpha.Minimum=0;alpha.Maximum=100;alpha.Value=100;alpha.TickFrequency=1;alpha.IsSnapToTickEnabled=true;
        captionAlpha.Minimum=0;captionAlpha.Maximum=100;captionAlpha.Value=90;captionAlpha.TickFrequency=1;captionAlpha.IsSnapToTickEnabled=true;
        font.Minimum=12;font.Maximum=32;font.Value=18;font.TickFrequency=1;font.IsSnapToTickEnabled=true;
        alpha.ValueChanged+=delegate {if(applying)return;transparency=alpha.Value;ApplyAppearance();SendAppearance();};
        captionAlpha.ValueChanged+=delegate {if(applying)return;captionOpacity=captionAlpha.Value;ApplyAppearance();SendAppearance();};
        font.ValueChanged+=delegate {if(applying)return;fontSize=font.Value;ApplyAppearance();SendAppearance();Center();};
        settingsFields.Add(Field("字号",fontLabel,font));settingsFields.Add(Field("窗口透明度",alphaLabel,alpha));settingsFields.Add(Field("字幕底色",captionAlphaLabel,captionAlpha));
        UniformGrid themeOptions=new UniformGrid {Columns=2};ConfigureOption(lightButton,"浅色 · 深字",delegate{theme="paper";ApplyAppearance();SendAppearance();});ConfigureOption(darkButton,"深色 · 浅字",delegate{theme="night";ApplyAppearance();SendAppearance();});themeOptions.Children.Add(lightButton);themeOptions.Children.Add(darkButton);
        UniformGrid layoutOptions=new UniformGrid {Columns=2};ConfigureOption(flowButton,"连续文本",delegate{ChangeLayout("flow");});ConfigureOption(linesButton,"逐句换行",delegate{ChangeLayout("lines");});layoutOptions.Children.Add(flowButton);layoutOptions.Children.Add(linesButton);
        settingsFields.Add(Field("配色",new TextBlock(),themeOptions));settingsFields.Add(Field("排版",new TextBlock(),layoutOptions));
        foreach(FrameworkElement field in settingsFields)settingsGrid.Children.Add(field);
        StackPanel body=new StackPanel();body.Children.Add(settingsGrid);body.Children.Add(new Expander {Header="调试信息",FontSize=10,Content=diagnostics,Margin=new Thickness(0,6,0,4)});
        settingsScroll.Content=body;settingsScroll.VerticalScrollBarVisibility=ScrollBarVisibility.Auto;settingsScroll.HorizontalScrollBarVisibility=ScrollBarVisibility.Disabled;
        settings.Child=PanelFrame("字幕外观",settingsScroll);settings.Margin=new Thickness(5);settings.Padding=new Thickness(12,6,12,8);settings.BorderThickness=new Thickness(1);canvas.Children.Add(settings);settings.Visibility=Visibility.Collapsed;
        rateGrid.Columns=3;
        foreach(double item in new double[]{0.25,0.5,0.75,1,1.25,1.5,1.75,2,2.5,3,4}) {
            double value=item;Button option=MakeButton(value.ToString("0.##")+"×",delegate{Command("setRate",value);});
            option.Tag=value;option.Margin=new Thickness(3);option.MinHeight=28;option.BorderThickness=new Thickness(1);rateGrid.Children.Add(option);rateButtons.Add(option);
        }
        ratePanel.Child=PanelFrame("播放速度",new ScrollViewer {Content=rateGrid,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,HorizontalScrollBarVisibility=ScrollBarVisibility.Disabled});ratePanel.Margin=new Thickness(5);ratePanel.Padding=new Thickness(12,6,12,8);ratePanel.BorderThickness=new Thickness(1);canvas.Children.Add(ratePanel);ratePanel.Visibility=Visibility.Collapsed;
        ArrangeSettings();
    }
    void ConfigureOption(Button button,string label,Action change){button.Content=label;button.FontSize=11;button.Margin=new Thickness(0,0,5,0);button.BorderThickness=new Thickness(1);button.Click+=delegate{change();};}
    FrameworkElement Field(string name,TextBlock value,UIElement control) {
        DockPanel heading=new DockPanel();value.FontSize=11;value.VerticalAlignment=VerticalAlignment.Center;DockPanel.SetDock(value,Dock.Right);heading.Children.Add(value);heading.Children.Add(new TextBlock {Text=name,FontSize=11,VerticalAlignment=VerticalAlignment.Center});
        StackPanel field=new StackPanel();field.Children.Add(heading);FrameworkElement element=control as FrameworkElement;if(element!=null)element.Margin=new Thickness(0,5,0,0);field.Children.Add(control);
        Border wrapper=new Border {Child=field,BorderThickness=new Thickness(0,1,0,0),Padding=new Thickness(0,7,0,7),Margin=new Thickness(0,0,16,0)};wrapper.SetResourceReference(Border.BorderBrushProperty,"ControlBorder");return wrapper;
    }
    Grid PanelFrame(string title,UIElement body) {
        Grid frame=new Grid();frame.RowDefinitions.Add(new RowDefinition {Height=GridLength.Auto});frame.RowDefinitions.Add(new RowDefinition {Height=new GridLength(1,GridUnitType.Star)});
        DockPanel header=new DockPanel {Margin=new Thickness(0,0,0,5)};Button back=MakeButton("← 返回",delegate{ClosePanels();rateButton.Focus();});DockPanel.SetDock(back,Dock.Right);header.Children.Add(back);
        header.Children.Add(new TextBlock {Text=title,FontFamily=new FontFamily("Georgia, SimSun"),FontSize=17,VerticalAlignment=VerticalAlignment.Center});frame.Children.Add(header);Grid.SetRow(body,1);frame.Children.Add(body);return frame;
    }
    void ArrangeSettings(){int columns=Width>=600?2:1;rateGrid.Columns=Width>=600?6:3;settingsGrid.ColumnDefinitions.Clear();settingsGrid.RowDefinitions.Clear();for(int c=0;c<columns;c++)settingsGrid.ColumnDefinitions.Add(new ColumnDefinition());for(int r=0;r<(settingsFields.Count+columns-1)/columns;r++)settingsGrid.RowDefinitions.Add(new RowDefinition {Height=GridLength.Auto});for(int i=0;i<settingsFields.Count;i++){Grid.SetColumn(settingsFields[i],i%columns);Grid.SetRow(settingsFields[i],i/columns);settingsFields[i].Margin=new Thickness(0,0,i%columns==columns-1?0:18,0);}}
    void OpenPanel(Border panel){Reveal(true);settings.Visibility=ratePanel.Visibility=Visibility.Collapsed;panel.Visibility=Visibility.Visible;top.Visibility=bottom.Visibility=Visibility.Collapsed;if(panel==settings)settingsScroll.ScrollToTop();}
    void ClosePanels(){settings.Visibility=ratePanel.Visibility=Visibility.Collapsed;if(showing)top.Visibility=bottom.Visibility=Visibility.Visible;}
    void UpdateRate(){rateButton.Content=currentRate.ToString("0.##")+"×";foreach(Button button in rateButtons)SelectOption(button,Math.Abs((double)button.Tag-currentRate)<0.01);}
    void SelectOption(Button button,bool selected){button.SetResourceReference(Control.ForegroundProperty,selected?"Accent":"ControlInk");button.SetResourceReference(Control.BackgroundProperty,selected?"SelectedSurface":"ControlSurface");button.FontWeight=selected?FontWeights.SemiBold:FontWeights.Normal;}
    void ChangeLayout(string value){if(layout==value)return;layout=value;RebuildCues();ApplyAppearance();SendAppearance();if(following)Dispatcher.BeginInvoke(new Action(Center),DispatcherPriority.Loaded);}
    void SendAppearance(){Program.Send(new{type="command",action="appearance",fontSize=fontSize,transparency=transparency,captionOpacity=captionOpacity,theme=theme,layout=layout});}
    void BuildGrips() {
        foreach(string edge in new string[]{"n","s","e","w","ne","nw","se","sw"}) {
            string dir=edge;
            Thumb grip=new Thumb {Background=Brushes.Transparent,Opacity=0.6};
            FrameworkElementFactory face=new FrameworkElementFactory(typeof(Border));face.SetValue(Border.BackgroundProperty,Brushes.Transparent);face.SetValue(Border.BorderBrushProperty,Brushes.SlateGray);face.SetValue(Border.BorderThicknessProperty,new Thickness(edge.Contains("w")?1:0,edge.Contains("n")?1:0,edge.Contains("e")?1:0,edge.Contains("s")?1:0));grip.Template=new ControlTemplate(typeof(Thumb)){VisualTree=face};
            bool vertical=edge=="n"||edge=="s", horizontal=edge=="w"||edge=="e";
            grip.Width=vertical?Double.NaN:8;grip.Height=horizontal?Double.NaN:8;
            grip.HorizontalAlignment=edge.Contains("w")?HorizontalAlignment.Left:edge.Contains("e")?HorizontalAlignment.Right:HorizontalAlignment.Stretch;
            grip.VerticalAlignment=edge.Contains("n")?VerticalAlignment.Top:edge.Contains("s")?VerticalAlignment.Bottom:VerticalAlignment.Stretch;
            if(vertical)grip.Margin=new Thickness(8,0,8,0);if(horizontal)grip.Margin=new Thickness(0,8,0,8);
            grip.Cursor=vertical?Cursors.SizeNS:horizontal?Cursors.SizeWE:(edge=="ne"||edge=="sw")?Cursors.SizeNESW:Cursors.SizeNWSE;
            grip.DragDelta+=delegate(object s,DragDeltaEventArgs e){ResizeEdge(dir,e.HorizontalChange,e.VerticalChange);};
            grip.DragCompleted+=delegate{SaveGeometry();if(!IsMouseOver)Reveal(false);};grips.Add(grip);canvas.Children.Add(grip);
        }
    }
    void ResizeEdge(string direction,double dx,double dy) {
        if(direction.Contains("e"))Width=Math.Max(MinWidth,Math.Min(3000,Width+dx));
        if(direction.Contains("s"))Height=Math.Max(MinHeight,Math.Min(1800,Height+dy));
        if(direction.Contains("w")){double newWidth=Math.Max(MinWidth,Math.Min(3000,Width-dx));Left+=Width-newWidth;Width=newWidth;}
        if(direction.Contains("n")){double newHeight=Math.Max(MinHeight,Math.Min(1800,Height-dy));Top+=Height-newHeight;Height=newHeight;}
    }
    void Reveal(bool visible) {
        showing=visible;top.Visibility=bottom.Visibility=visible && settings.Visibility!=Visibility.Visible && ratePanel.Visibility!=Visibility.Visible?Visibility.Visible:Visibility.Collapsed;
        if(!visible)settings.Visibility=ratePanel.Visibility=Visibility.Collapsed;
        foreach(Thumb grip in grips)grip.Visibility=visible?Visibility.Visible:Visibility.Collapsed;
        // 仅工具栏显示时避让；移出即回收全部高度，不保留空白栏。
        scroll.Margin=new Thickness(10,visible?36:4,10,visible?42:4);
        scroll.VerticalScrollBarVisibility=visible?ScrollBarVisibility.Auto:ScrollBarVisibility.Hidden;
        if(following)Dispatcher.BeginInvoke(new Action(Center),DispatcherPriority.Loaded);
    }
    void ApplyAppearance() {
        bool dark=theme=="night";
        // 100% 时保留 1/255 的命中层，肉眼透明且仍能移入唤出控制。
        byte a=(byte)Math.Max(1,Math.Round(255*(100-transparency)/100));
        canvas.Background=new SolidColorBrush(dark?Color.FromArgb(a,30,29,26):Color.FromArgb(a,247,244,237));
        Brush panel=new SolidColorBrush(dark?Color.FromRgb(30,29,26):Color.FromRgb(247,244,237));
        Brush ink=new SolidColorBrush(dark?Color.FromRgb(242,237,226):Color.FromRgb(37,35,31));
        Brush rule=new SolidColorBrush(dark?Color.FromRgb(78,74,67):Color.FromRgb(214,208,196));
        Resources["ControlSurface"]=panel;Resources["ControlInk"]=ink;Resources["ControlBorder"]=rule;
        Resources["Accent"]=new SolidColorBrush(dark?Color.FromRgb(231,182,156):Color.FromRgb(154,73,56));
        Resources["ControlHover"]=Resources["SelectedSurface"]=new SolidColorBrush(dark?Color.FromRgb(58,48,41):Color.FromRgb(236,226,216));
        top.Background=bottom.Background=settings.Background=ratePanel.Background=panel;
        top.BorderBrush=bottom.BorderBrush=settings.BorderBrush=ratePanel.BorderBrush=rule;
        Foreground=text.Foreground=ink;
        text.FontSize=fontSize;text.LineHeight=fontSize*1.6;
        text.Effect=null;
        alphaLabel.Text=Math.Round(transparency)+"%";captionAlphaLabel.Text=Math.Round(captionOpacity)+"% 不透明";fontLabel.Text=Math.Round(fontSize)+"px";
        SelectOption(lightButton,theme=="paper");SelectOption(darkButton,theme=="night");SelectOption(flowButton,layout=="flow");SelectOption(linesButton,layout=="lines");UpdateRate();
        for(int i=0;i<lines.Count;i++)StyleLine(i);
        if(lines.Count==0)foreach(Inline inline in text.Inlines){inline.Background=Brushes.Transparent;inline.Foreground=text.Foreground;}
        captionBackdrop.Fill=CaptionBrush();captionBackdrop.InvalidateVisual();
    }
    SolidColorBrush CaptionBrush(){byte alpha=(byte)Math.Round(255*captionOpacity/100);return new SolidColorBrush(theme=="night"?Color.FromArgb(alpha,30,29,26):Color.FromArgb(alpha,247,244,237));}
    void StyleLine(int index) {
        Hyperlink line=lines[index];bool current=index==active;
        line.Foreground=text.Foreground;line.Background=Brushes.Transparent;
        if(current){TextDecoration mark=new TextDecoration {Location=TextDecorationLocation.Underline,Pen=new Pen((Brush)Resources["Accent"],1.3),PenThicknessUnit=TextDecorationUnit.Pixel,PenOffsetUnit=TextDecorationUnit.Pixel,PenOffset=1};line.TextDecorations=new TextDecorationCollection {mark};}
        else line.TextDecorations=null;
    }
    static double Number(Dictionary<string,object>d,string key,double fallback){object o;double v;if(!d.TryGetValue(key,out o)||!Double.TryParse(Convert.ToString(o,System.Globalization.CultureInfo.InvariantCulture),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out v)||Double.IsNaN(v)||Double.IsInfinity(v))return fallback;return v;}
    static string StringValue(Dictionary<string,object>d,string key,string fallback){object o;return d.TryGetValue(key,out o)&&o is string?(string)o:fallback;}
    internal void Apply(Dictionary<string,object> data) {
        if(isClosed)return;
        string type=StringValue(data,"type","");if(type=="close"){Close();return;}if(type!="state")return;
        applying=true;
        try {
            seconds=Math.Max(0,Number(data,"time",seconds));step=Math.Max(1,Math.Min(120,Number(data,"step",step)));
            fontSize=Math.Max(12,Math.Min(32,Number(data,"fontSize",fontSize)));transparency=Math.Max(0,Math.Min(100,Number(data,"transparency",transparency)));captionOpacity=Math.Max(0,Math.Min(100,Number(data,"captionOpacity",captionOpacity)));
            theme=StringValue(data,"theme",theme)=="paper"?"paper":"night";alpha.Value=transparency;font.Value=fontSize;captionAlpha.Value=captionOpacity;
            string nextLayout=StringValue(data,"layout",layout)=="lines"?"lines":"flow";bool layoutChanged=nextLayout!=layout;layout=nextLayout;
            object paused;play.Content=data.TryGetValue("paused",out paused)&&paused is bool&&(bool)paused?"▷":"Ⅱ";
            currentRate=Number(data,"rate",currentRate);
            clock.Text=((int)seconds/60)+":"+((int)seconds%60).ToString("00");backward.Content="−"+step+"s";forward.Content="+"+step+"s";
            lastStatus=StringValue(data,"status",lastStatus);status.Text="字幕 · "+(lastStatus.Length>0?lastStatus:"拖动移动");
            object list;bool replaced=data.TryGetValue("cues",out list)&&list is IEnumerable && !(list is string);
            if(replaced){
                cueData.Clear();
                foreach(object entry in (IEnumerable)list){Dictionary<string,object> cue=entry as Dictionary<string,object>;if(cue==null||cueData.Count>=200)continue;
                    string content=StringValue(cue,"text","");if(content.Length>5000)content=content.Substring(0,5000);
                    cueData.Add(new Dictionary<string,object>{{"start",Number(cue,"start",0)},{"end",Number(cue,"end",Number(cue,"start",0)+1)},{"text",content}});
                }
            }
            if(replaced||layoutChanged)RebuildCues();
            int index=(int)Number(data,"index",active);if(index<-1||index>=lines.Count)index=-1;bool changed=index!=active;active=index;
            diagnostics.Text="来源 "+StringValue(data,"source","")+" · 当前窗口 "+lines.Count+" 句 · 时间 "+seconds.ToString("0.0")+" s · 局部索引 "+active;
            if(lines.Count==0){fullText=lastStatus.Length>0?lastStatus:"等待字幕…";text.Inlines.Clear();text.Inlines.Add(new Run(fullText));}
            ApplyAppearance();
            if((changed||replaced||layoutChanged)&&following)Dispatcher.BeginInvoke(new Action(Center),DispatcherPriority.Loaded);
        } finally {applying=false;}
    }
    void RebuildCues() {
        double previousScroll=scroll.VerticalOffset, anchorStart=-1, anchorOffset=0;
        if(!following)for(int i=0;i<lines.Count;i++) {Rect rect=CueBounds(i);if(!rect.IsEmpty && rect.Bottom>=previousScroll){anchorStart=starts[i];anchorOffset=rect.Top-previousScroll;break;}}
        text.Inlines.Clear();lines.Clear();starts.Clear();offsets.Clear();lengths.Clear();fullText="";
        for(int i=0;i<cueData.Count;i++) {
            Dictionary<string,object> cue=cueData[i];string content=(string)cue["text"];double start=(double)cue["start"];
            Hyperlink link=new Hyperlink(new Run(content));link.Cursor=Cursors.Hand;link.Click+=delegate{following=true;follow.Visibility=Visibility.Collapsed;Command("seekTo",start);};
            offsets.Add(fullText.Length);lengths.Add(content.Length);fullText+=content;lines.Add(link);starts.Add(start);text.Inlines.Add(link);
            if(i+1<cueData.Count){string separator=layout=="lines"?"\n":" ";fullText+=separator;text.Inlines.Add(new Run(separator));}
        }
        if(lines.Count==0){fullText=lastStatus.Length>0?lastStatus:"等待字幕…";text.Inlines.Add(new Run(fullText));}
        text.InvalidateMeasure();
        plateGeometry=null;captionBackdrop.InvalidateVisual();
        if(!following)Dispatcher.BeginInvoke(new Action(delegate {
            text.UpdateLayout();int at=starts.IndexOf(anchorStart);Rect rect=at>=0?CueBounds(at):Rect.Empty;
            scroll.ScrollToVerticalOffset(!rect.IsEmpty?Math.Max(0,rect.Top-anchorOffset):previousScroll);
        }),DispatcherPriority.Loaded);
    }
    void Center() {
        if(!following||active<0||active>=lines.Count)return;
        text.UpdateLayout();Rect bounds=CueBounds(active);if(bounds.IsEmpty)return;
        scroll.ScrollToVerticalOffset(Math.Max(0,bounds.Top-(bounds.Height>scroll.ViewportHeight?2:(scroll.ViewportHeight-bounds.Height)/2)));
    }
    FormattedText Formatted() {
        double width=Math.Max(1,text.ActualWidth-text.Padding.Left-text.Padding.Right);
        if(cachedLayout!=null && cachedText==fullText && cachedWidth==width && cachedFont==fontSize)return cachedLayout;
        FormattedText formatted=new FormattedText(fullText,System.Globalization.CultureInfo.GetCultureInfo("zh-CN"),FlowDirection.LeftToRight,new Typeface(text.FontFamily,text.FontStyle,text.FontWeight,text.FontStretch),fontSize,Brushes.White,VisualTreeHelper.GetDpi(text).PixelsPerDip);
        formatted.MaxTextWidth=width;formatted.LineHeight=text.LineHeight;
        cachedText=fullText;cachedWidth=width;cachedFont=fontSize;cachedLayout=formatted;return formatted;
    }
    Rect CueBounds(int index) {
        if(index<0 || index>=offsets.Count || lengths[index]==0)return Rect.Empty;
        // TextBlock 的 TextPointer 在跨行 Hyperlink 上可能退化为句尾，使用同字体/宽度/行距的排版几何。
        Geometry geometry=Formatted().BuildHighlightGeometry(new Point(text.Padding.Left,0),offsets[index],lengths[index]);
        return geometry==null?Rect.Empty:geometry.Bounds;
    }
    Geometry PlateGeometry() {
        if(fullText.Length==0||text.ActualWidth<=0)return null;
        if(plateGeometry!=null&&plateText==fullText&&plateWidth==text.ActualWidth&&plateFont==fontSize)return plateGeometry;
        FormattedText formatted=Formatted();GeometryGroup group=new GeometryGroup {FillRule=FillRule.Nonzero};
        int count=lines.Count==0?1:offsets.Count;
        for(int i=0;i<count;i++) {
            int start=lines.Count==0?0:offsets[i],length=lines.Count==0?fullText.Length:lengths[i];if(length<=0)continue;
            Geometry shape=formatted.BuildHighlightGeometry(new Point(text.Padding.Left,0),start,length);if(shape==null)continue;
            group.Children.Add(shape);group.Children.Add(shape.GetWidenedPathGeometry(new Pen(Brushes.Black,4){LineJoin=PenLineJoin.Round}));
        }
        // 非零填充一次绘制：相邻句的 2px 内衬交叠时也不会叠加透明度。
        group.Freeze();plateText=fullText;plateWidth=text.ActualWidth;plateFont=fontSize;plateGeometry=group;return group;
    }
    void LoadGeometry() {
        try {
            Dictionary<string,object>d=Program.Json.DeserializeObject(File.ReadAllText(preferencePath)) as Dictionary<string,object>;if(d==null)return;
            Width=Math.Max(MinWidth,Math.Min(1600,Number(d,"width",Width)));Height=Math.Max(MinHeight,Math.Min(1000,Number(d,"height",Height)));
            Left=Number(d,"left",Left);Top=Number(d,"top",Top);
            Rect virtualScreen=new Rect(SystemParameters.VirtualScreenLeft,SystemParameters.VirtualScreenTop,SystemParameters.VirtualScreenWidth,SystemParameters.VirtualScreenHeight);
            if(!virtualScreen.IntersectsWith(new Rect(Left,Top,Width,Height))){Left=SystemParameters.WorkArea.Right-Width-30;Top=SystemParameters.WorkArea.Bottom-Height-30;}
        }catch{}
    }
    void SaveGeometry(){if(Program.Testing||Program.ProtocolTesting)return;try{Directory.CreateDirectory(Path.GetDirectoryName(preferencePath));File.WriteAllText(preferencePath,Program.Json.Serialize(new{left=Left,top=Top,width=Width,height=Height}));}catch{}}
    void FlushLayout(){Dispatcher.Invoke(new Action(delegate{}),DispatcherPriority.ApplicationIdle);canvas.UpdateLayout();}
    RenderTargetBitmap Capture(string path,double scale=1) {
        FlushLayout();
        canvas.Measure(new Size(Width,Height));canvas.Arrange(new Rect(0,0,Width,Height));canvas.UpdateLayout();
        RenderTargetBitmap bitmap=new RenderTargetBitmap((int)(Width*scale),(int)(Height*scale),96*scale,96*scale,PixelFormats.Pbgra32);bitmap.Render(canvas);
        PngBitmapEncoder encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using(FileStream stream=File.Create(path))encoder.Save(stream);
        return bitmap;
    }
    void ReadabilityPreview(string path,RenderTargetBitmap foreground) {
        // 仅自绘测试底图，不读取屏幕、网页或其他应用。
        DrawingVisual visual=new DrawingVisual();
        using(DrawingContext drawing=visual.RenderOpen()) {
            drawing.DrawRectangle(Brushes.White,null,new Rect(0,0,Width,Height));drawing.DrawRectangle(Brushes.Black,null,new Rect(Width/2,0,Width/2,Height));
            for(int column=0;column<2;column++)for(int row=0;row<13;row++) {
                FormattedText noise=new FormattedText("工作记录  任务清单 / 2026  信息密集背景  ABC 123",System.Globalization.CultureInfo.GetCultureInfo("zh-CN"),FlowDirection.LeftToRight,new Typeface("Microsoft YaHei UI"),12,column==0?Brushes.Black:Brushes.White,1);
                noise.MaxTextWidth=Width/2-12;drawing.DrawText(noise,new Point(column*Width/2+6,row*17));
            }
            drawing.DrawImage(foreground,new Rect(0,0,Width,Height));
            FormattedText label=new FormattedText("离线自绘背景 · 非真实桌面",System.Globalization.CultureInfo.GetCultureInfo("zh-CN"),FlowDirection.LeftToRight,new Typeface("Microsoft YaHei UI"),10,Brushes.Gray,1);drawing.DrawText(label,new Point(Width-180,Height-16));
        }
        RenderTargetBitmap bitmap=new RenderTargetBitmap((int)Width,(int)Height,96,96,PixelFormats.Pbgra32);bitmap.Render(visual);PngBitmapEncoder encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using(FileStream stream=File.Create(path))encoder.Save(stream);
    }
    byte[] Pixel(BitmapSource bitmap,int x,int y){byte[] result=new byte[4];bitmap.CopyPixels(new Int32Rect(x,y,1,1),result,4,0);return result;}
    int PlatePixel(BitmapSource bitmap,Rect bounds) {
        Point origin=text.TransformToAncestor(canvas).Transform(new Point(0,0));Color plate=CaptionBrush().Color;
        int minX=Math.Max(0,(int)Math.Ceiling(origin.X+bounds.Left)),maxX=Math.Min(bitmap.PixelWidth-1,(int)Math.Floor(origin.X+bounds.Right));
        int minY=Math.Max(0,(int)Math.Ceiling(origin.Y+bounds.Top)),maxY=Math.Min(bitmap.PixelHeight-1,(int)Math.Floor(origin.Y+bounds.Bottom));
        for(int y=minY;y<=maxY;y++)for(int x=minX;x<=maxX;x++) {
            byte[] pixel=Pixel(bitmap,x,y);int a=pixel[3];if(Math.Abs(a-plate.A)>1)continue;
            if(Math.Abs(pixel[0]-plate.B*a/255.0)<3&&Math.Abs(pixel[1]-plate.G*a/255.0)<3&&Math.Abs(pixel[2]-plate.R*a/255.0)<3)return a;
        }
        throw new Exception("找不到对应字幕底色的实际渲染像素");
    }
    int PlateMaximumAlpha() {
        DrawingVisual visual=new DrawingVisual();Point origin=text.TransformToAncestor(canvas).Transform(new Point(0,0));
        using(DrawingContext drawing=visual.RenderOpen()){drawing.DrawRectangle(canvas.Background,null,new Rect(0,0,Width,Height));drawing.PushTransform(new TranslateTransform(origin.X,origin.Y));drawing.DrawGeometry(captionBackdrop.Fill,null,PlateGeometry());drawing.Pop();}
        RenderTargetBitmap bitmap=new RenderTargetBitmap((int)Width,(int)Height,96,96,PixelFormats.Pbgra32);bitmap.Render(visual);byte[] pixels=new byte[(int)Width*(int)Height*4];bitmap.CopyPixels(pixels,(int)Width*4,0);int maximum=0;
        for(int i=3;i<pixels.Length;i+=4)maximum=Math.Max(maximum,pixels[i]);return maximum;
    }
    void ReadabilityTest(string dir) {
        Width=760;Height=192;ArrangeSettings();following=true;
        object[] sample=new object[]{
            new Dictionary<string,object>{{"start",0},{"end",4},{"text","工作界面的内容再密集，字幕也应该能够轻松读清。"}},
            new Dictionary<string,object>{{"start",4},{"end",8},{"text","当前句只用下划线标记，每一句都有贴着文字的底色。"}},
            new Dictionary<string,object>{{"start",8},{"end",16},{"text","空白仍然透明。长句自然换行，每一行的背景随文字结束，不把整张字幕框涂成色块。"}}
        };
        Apply(new Dictionary<string,object>{{"type","state"},{"cues",sample},{"time",6},{"index",1},{"theme","paper"},{"layout","flow"},{"fontSize",20},{"transparency",100},{"captionOpacity",90}});Reveal(false);FlushLayout();Center();FlushLayout();
        RenderTargetBitmap light=Capture(Path.Combine(dir,"native-v6-light-transparent.png"));ReadabilityPreview(Path.Combine(dir,"native-v6-light-readability.png"),light);
        int regularAlpha=PlatePixel(light,CueBounds(0)),activeAlpha=PlatePixel(light,CueBounds(1));
        int maximumPlateAlpha=PlateMaximumAlpha();if(maximumPlateAlpha>231||maximumPlateAlpha<229)throw new Exception("相邻字幕底色重叠后透明度加深");
        if(regularAlpha!=activeAlpha||Math.Abs(activeAlpha-230)>1||Pixel(light,740,180)[3]!=1)throw new Exception("字幕底色与空白透明度不独立");
        if(((SolidColorBrush)lines[0].Foreground).Color!=((SolidColorBrush)lines[1].Foreground).Color||((SolidColorBrush)lines[0].Background).Color!=((SolidColorBrush)lines[1].Background).Color)throw new Exception("当前与非当前字幕颜色不一致");
        if(lines[0].TextDecorations!=null&&lines[0].TextDecorations.Count>0||lines[1].TextDecorations==null||lines[1].TextDecorations.Count!=1)throw new Exception("下划线应仅标记当前句");
        Color mark=((SolidColorBrush)lines[1].TextDecorations[0].Pen.Brush).Color;if(mark!=Color.FromRgb(154,73,56))throw new Exception("当前句下划线颜色不正确");
        Rect current=CueBounds(active);if(current.Top-scroll.VerticalOffset< -1||current.Bottom-scroll.VerticalOffset>scroll.ViewportHeight+1)throw new Exception("自动跟随裁掉了当前句");
        Apply(new Dictionary<string,object>{{"type","state"},{"theme","night"}});Reveal(false);FlushLayout();RenderTargetBitmap dark=Capture(Path.Combine(dir,"native-v6-dark-transparent.png"));ReadabilityPreview(Path.Combine(dir,"native-v6-dark-readability.png"),dark);
        int darkAlpha=PlatePixel(dark,CueBounds(0));if(Math.Abs(darkAlpha-230)>1)throw new Exception("深色字幕底色像素不正确");
        linesButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));FlushLayout();RenderTargetBitmap sentence=Capture(Path.Combine(dir,"native-v6-lines.png"));ReadabilityPreview(Path.Combine(dir,"native-v6-lines-readability.png"),sentence);
        if(active!=1||!fullText.Contains("\n")||(double)cueData[1]["end"]!=8)throw new Exception("字幕底色改变了逐句时间轴");
        lines[1].RaiseEvent(new RoutedEventArgs(Hyperlink.ClickEvent));if(!Program.Json.Serialize(Program.LastTestMessage).Contains("\"value\":4"))throw new Exception("贴底字幕点击跳转失效");
        string wrapping="这是一句长字幕，它会自然换行。每行底色随这一行文字的长度结束，不铺满右侧空白；文字和底色保持一致，当前播放位置由下划线说明。";
        Apply(new Dictionary<string,object>{{"type","state"},{"layout","flow"},{"theme","paper"},{"index",0},{"cues",new object[]{new Dictionary<string,object>{{"start",0},{"end",20},{"text",wrapping}}}}});Reveal(false);FlushLayout();Center();FlushLayout();
        RenderTargetBitmap wrapped=Capture(Path.Combine(dir,"native-v6-wrapped.png"));ReadabilityPreview(Path.Combine(dir,"native-v6-wrapped-readability.png"),wrapped);
        Rect last=Formatted().BuildHighlightGeometry(new Point(text.Padding.Left,0),wrapping.Length-1,1).Bounds;int wrappedRows=(int)Math.Ceiling(Formatted().Height/text.LineHeight);
        if(wrappedRows<2)throw new Exception("长句未形成多行贴底");
        Point textOrigin=text.TransformToAncestor(canvas).Transform(new Point(0,0));int tailX=(int)Math.Ceiling(textOrigin.X+last.Right+8),tailY=(int)(textOrigin.Y+last.Top+last.Height/2);
        if(tailX>=wrapped.PixelWidth||Pixel(wrapped,tailX,tailY)[3]!=1)throw new Exception("长句最后一行底色填满了尾部空白");
        captionAlpha.Value=50;FlushLayout();RenderTargetBitmap half=Capture(Path.Combine(dir,"native-v6-half-opacity.png"));int halfAlpha=PlatePixel(half,CueBounds(0));if(Math.Abs(halfAlpha-128)>1||transparency!=100)throw new Exception("字幕底色滑块改变了窗口透明度");
        if(!Program.Json.Serialize(Program.LastTestMessage).Contains("\"captionOpacity\":50"))throw new Exception("字幕底色偏好未回传");
        captionAlpha.Value=0;FlushLayout();if(PlateMaximumAlpha()!=1||transparency!=100)throw new Exception("0%字幕底色没有恢复透明");
        Apply(new Dictionary<string,object>{{"type","state"},{"cues",new object[0]},{"source","dom"},{"status","这是 DOM 兜底的当前句，也有独立的字幕底色。"},{"captionOpacity",90}});Reveal(false);FlushLayout();
        RenderTargetBitmap dom=Capture(Path.Combine(dir,"native-v6-dom.png"));ReadabilityPreview(Path.Combine(dir,"native-v6-dom-readability.png"),dom);
        if(text.Inlines.FirstInline==null||((SolidColorBrush)captionBackdrop.Fill).Color.A!=230)throw new Exception("DOM 当前句缺少字幕底色");
        int domAlpha=PlatePixel(dom,new Rect(1,0,Formatted().Width,Formatted().Height));if(Math.Abs(domAlpha-230)>1)throw new Exception("DOM 底色没有实际绘制");
        OpenPanel(settings);Capture(Path.Combine(dir,"native-v6-settings.png"));settingsScroll.ScrollToEnd();FlushLayout();Capture(Path.Combine(dir,"native-v6-settings-bottom.png"));
        File.WriteAllText(Path.Combine(dir,"native-v6-checks.json"),Program.Json.Serialize(new{kind="isolated-native-offscreen",captionOpacity=90,regularBackgroundAlpha=regularAlpha,currentBackgroundAlpha=activeAlpha,darkBackgroundAlpha=darkAlpha,halfOpacityAlpha=halfAlpha,emptyAlpha=1,maximumPlateAlpha=maximumPlateAlpha,captionPadding=2,regularAndCurrentColorEqual=true,onlyCurrentUnderlined=true,wrappedRows=wrappedRows,tailBlankAlpha=1,domBackgroundAlpha=domAlpha,currentCueFullyVisible=true,simulatedBackground="self-drawn black/white dense text, no screen capture",checks=new[]{"all captions have per-line fitted backgrounds","90% plates over 100% transparent window","same text and plate colors for current and context","accent underline only on current cue","wrapped final line leaves empty tail transparent","DOM fallback actual pixel alpha","2px padding merged in one draw without darker overlap","independent 0/50/90% opacity settings and appearance roundtrip","flow/lines/click/rate regression retained"}}));
    }
    internal void SelfTest(string dir) {
        Directory.CreateDirectory(dir);
        int style=GetWindowLong(new WindowInteropHelper(this).Handle,-20);
        if((style&0x80000)==0 || (style&8)==0)throw new Exception("窗口没有 layered / topmost 样式");
        string sample="{\"type\":\"state\",\"time\":6,\"paused\":true,\"index\":1,\"theme\":\"night\",\"transparency\":95,\"fontSize\":18,\"cues\":[{\"start\":0,\"text\":\"这是独立的 Windows 透明置顶窗口。\"},{\"start\":4,\"text\":\"字幕保持清晰，背景可以透出后方桌面。\"},{\"start\":8,\"text\":\"鼠标离开后，整个框内都用于字幕，不留工具栏空位。\"},{\"start\":12,\"text\":\"移入后可以拖动、缩放、播放、快进和调整外观。\"}]}";
        Apply(Program.Json.DeserializeObject(sample) as Dictionary<string,object>);Reveal(false);FlushLayout();
        double idleHeight=scroll.ActualHeight;Capture(Path.Combine(dir,"native-idle.png"));
        Reveal(true);FlushLayout();double hoverHeight=scroll.ActualHeight;Capture(Path.Combine(dir,"native-hover.png"));
        if(hoverHeight>=idleHeight || idleHeight<Height-10)throw new Exception("字幕区未按工具栏可见性回收空间");
        transparency=100;ApplyAppearance();Reveal(false);RenderTargetBitmap transparentImage=Capture(Path.Combine(dir,"native-transparent.png"));
        if(Math.Abs(scroll.ActualHeight-idleHeight)>1)throw new Exception("工具栏收起后未恢复全部字幕空间");
        byte[] pixel=new byte[4];transparentImage.CopyPixels(new Int32Rect(400,160,1,1),pixel,4,0);
        if(pixel[3]!=1)throw new Exception("导出的原生窗口背景不是透明像素");
        Color color=((SolidColorBrush)canvas.Background).Color;
        if(color.A!=1)throw new Exception("透明背景不正确");
        // 用真实 WPF 文本布局验证长句和当前句定位，不依赖浏览器模拟。
        List<Dictionary<string,object>> longCues=new List<Dictionary<string,object>>();
        for(int i=0;i<60;i++)longCues.Add(new Dictionary<string,object>{{"start",i*3},{"text","第"+i+"句，保持原始字幕时间，连续阅读会自动换行。"}});
        Dictionary<string,object> longState=new Dictionary<string,object>{{"type","state"},{"cues",longCues},{"index",40},{"time",120}};
        Apply(longState);FlushLayout();Center();FlushLayout();
        double followed=scroll.VerticalOffset;Rect activeRect=CueBounds(40);
        if(followed<=0 || activeRect.Top-followed< -2 || activeRect.Top-followed>scroll.ViewportHeight)throw new Exception("跟随坐标不正确");
        following=false;scroll.ScrollToVerticalOffset(100);FlushLayout();double held=scroll.VerticalOffset;
        Apply(new Dictionary<string,object>{{"type","state"},{"index",45}});FlushLayout();Center();FlushLayout();
        if(Math.Abs(held-scroll.VerticalOffset)>1)throw new Exception("手动阅读被拉回");
        string longText=new string('长',1600);following=true;
        Apply(new Dictionary<string,object>{{"type","state"},{"index",0},{"cues",new object[]{new Dictionary<string,object>{{"start",0},{"text",longText}}}}});
        FlushLayout();Center();FlushLayout();
        if(text.ActualHeight<=scroll.ViewportHeight || ((Run)lines[0].Inlines.FirstInline).Text!=longText || scroll.VerticalOffset>2)throw new Exception("长句未完整换行或未从头显示");
        if(Math.Abs(Formatted().Height-text.ActualHeight)>2)throw new Exception("定位排版几何与实际高度不一致");
        double measuredLongTextHeight=text.ActualHeight;
        play.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        if(!Program.Json.Serialize(Program.LastTestMessage).Contains("\"action\":\"toggle\""))throw new Exception("播放按钮未发出命令");
        OpenPanel(ratePanel);foreach(Button option in rateButtons)if((double)option.Tag==1.5)option.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        if(!Program.Json.Serialize(Program.LastTestMessage).Contains("\"action\":\"setRate\""))throw new Exception("倍速未发出命令");
        font.Value=20;
        if(!Program.Json.Serialize(Program.LastTestMessage).Contains("\"action\":\"appearance\""))throw new Exception("字号未同步回扩展");
        // v0.5：同窗口倍速面板不会被播放状态刷新关闭，也不创建 Popup。
        Apply(Program.Json.DeserializeObject(sample) as Dictionary<string,object>);OpenPanel(ratePanel);foreach(Button option in rateButtons)if((double)option.Tag==1.5)option.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        for(int n=0;n<8;n++)Apply(new Dictionary<string,object>{{"type","state"},{"time",6+n*0.25},{"rate",1}});
        if(ratePanel.Visibility!=Visibility.Visible || Math.Abs(currentRate-1)>0.01)throw new Exception("连续状态刷新干扰倍速选择或虚报成功");
        Apply(new Dictionary<string,object>{{"type","state"},{"rate",1.5}});
        theme="paper";ApplyAppearance();Capture(Path.Combine(dir,"native-v5-rate.png"));
        ClosePanels();following=true;layout="flow";RebuildCues();FlushLayout();double flowHeight=Formatted().Height;int previousIndex=active;double savedEnd=(double)cueData[1]["end"];
        linesButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));FlushLayout();double linesHeight=Formatted().Height;
        if(linesHeight<=flowHeight || active!=previousIndex || !fullText.Contains("\n") || (double)cueData[1]["end"]!=savedEnd)throw new Exception("排版诊断 flow="+flowHeight+" lines="+linesHeight+" active="+active+" previous="+previousIndex+" layout="+layout);
        if(!Program.Json.Serialize(Program.LastTestMessage).Contains("\"layout\":\"lines\""))throw new Exception("排版偏好未回传");
        lines[1].RaiseEvent(new RoutedEventArgs(Hyperlink.ClickEvent));
        if(!Program.Json.Serialize(Program.LastTestMessage).Contains("\"action\":\"seekTo\"") || !Program.Json.Serialize(Program.LastTestMessage).Contains("\"value\":4"))throw new Exception("切排版后点击跳转失效");
        layout="flow";RebuildCues();ApplyAppearance();Reveal(false);FlushLayout();Capture(Path.Combine(dir,"native-v5-light.png"));
        Reveal(true);Capture(Path.Combine(dir,"native-v5-light-hover.png"));
        OpenPanel(settings);FlushLayout();Capture(Path.Combine(dir,"native-v5-settings.png"));
        Color settingsColor=((SolidColorBrush)settings.Background).Color;if(settingsColor.A!=255)throw new Exception("设置面板不能透出字幕");
        RenderTargetBitmap highDpi=Capture(Path.Combine(dir,"native-v5-settings-150pct.png"),1.5);if(highDpi.PixelWidth!=1140)throw new Exception("150%渲染尺寸不正确");
        Width=360;Height=160;ArrangeSettings();FlushLayout();settingsScroll.ScrollToTop();FlushLayout();Capture(Path.Combine(dir,"native-v5-settings-narrow.png"));
        if(settingsGrid.ColumnDefinitions.Count!=1 || settingsScroll.ExtentHeight<=settingsScroll.ViewportHeight || settingsScroll.ViewportHeight<50)throw new Exception("窄窗设置未提供可用滚动区");
        settingsScroll.ScrollToEnd();FlushLayout();Capture(Path.Combine(dir,"native-v5-settings-narrow-bottom.png"));
        FrameworkElement lastSetting=settingsFields[settingsFields.Count-1];Point lastField=lastSetting.TransformToAncestor(settings).Transform(new Point(0,lastSetting.ActualHeight));
        if(lastField.Y>settings.ActualHeight+2)throw new Exception("窄窗排版控件被裁掉");
        Reveal(false);if(settings.Visibility==Visibility.Visible || ratePanel.Visibility==Visibility.Visible)throw new Exception("鼠标离开后面板仍显示");
        Width=760;Height=192;ArrangeSettings();theme="night";ApplyAppearance();FlushLayout();Capture(Path.Combine(dir,"native-v5-dark.png"));OpenPanel(settings);Capture(Path.Combine(dir,"native-v5-settings-dark.png"));
        File.WriteAllText(Path.Combine(dir,"native-v5-checks.json"),Program.Json.Serialize(new {kind="isolated-native-offscreen",ratePanelSurvivesStateUpdates=true,selectedRate=currentRate,noPopup=true,flowHeight=flowHeight,linesHeight=linesHeight,cueEndPreserved=true,clickSeekPreserved=true,settingsOpaque=settingsColor.A,narrowSettingsScrollable=true,renderScale=1.5,checks=new[]{"in-window rate picker through repeated state updates","rate command and acknowledgement","flow and lines preserve timing and highlight","opaque settings with fixed header and scroll body","360x160 single-column settings fully reachable","150% self-render","light/dark editorial style"}}));
        File.WriteAllText(Path.Combine(dir,"native-checks.json"),Program.Json.Serialize(new {kind="isolated-native-offscreen",layered=true,topmost=true,allowsTransparency=AllowsTransparency,idleSubtitleHeight=idleHeight,hoverSubtitleHeight=hoverHeight,windowHeight=Height,backgroundAlphaAt100=color.A,renderedBackgroundAlpha=pixel[3],foregroundAlpha=((SolidColorBrush)text.Foreground).Color.A,followedScroll=followed,activeYInViewport=activeRect.Top-followed,longTextCharacters=longText.Length,longTextHeight=measuredLongTextHeight,checks=new[]{"real HWND layered and topmost styles","full-frame idle captions restored after toolbar hides","rendered transparent alpha independent of text","native long text wrap and no truncation","formatted geometry matches actual text height","manual scrolling not overridden","play rate appearance commands","native window only rendering, no desktop capture"}}));
        ReadabilityTest(dir);
        string oldError=Path.Combine(dir,"native-test-error.txt");if(File.Exists(oldError))File.Delete(oldError);
    }
}
